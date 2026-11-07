/**
 * ============================================================
 *  Divisor de Parágrafos + Cortador de Encheção de Linguiça
 *  (Paragraph Breaker + Fluff Trimmer) — SillyTavern Extension
 * ============================================================
 *  1) Divide parágrafos longos e densos em blocos menores e fluídos
 *  2) Detecta e remove parágrafos repetitivos de "encheção"
 *     (descrições infinitas de pôr do sol, vento, sombras)
 *     sem deixar o roleplay seco!
 *
 *  Autor  : YasminIsis
 *  Versão : 1.2.0 (Totalmente em Português)
 *  Licença: MIT
 * ============================================================
 */

import { extension_settings, saveMetadataDebounced } from '../../../extensions.js';
import { eventSource, event_types, saveChatDebounced } from '../../../../script.js';

// ── Constantes ────────────────────────────────────────────────
const MODULE_NAME = 'paragraph_breaker';
const LOG_PREFIX = '[DivisorDeParagrafos]';

// ── Configurações Padrão ──────────────────────────────────────
const DEFAULT_SETTINGS = {
    // Divisor de Parágrafos
    enabled: true,
    maxSentences: 4,           // Máximo de frases antes de quebrar
    maxCharacters: 500,        // Máximo de letras por parágrafo
    processExisting: false,
    splitDialogue: true,       // Colocar falas com aspas em parágrafos separados
    preserveFormatting: true,  // Manter *itálicos* e **negritos**

    // Cortador de Encheção (Fluff Trimmer)
    fluffTrimmerEnabled: true,
    fluffAggressiveness: 'balanced',   // 'conservative' | 'balanced' | 'aggressive'
    maxAtmosphericParagraphs: 1,       // Quantos parágrafos de ambiente manter por mensagem
    trimBookends: true,                // Foco especial no início e final da mensagem
    protectDialogue: true,             // NUNCA cortar parágrafos com diálogo/falas
    showTrimmedIndicator: true,        // Registrar cortes no console (F12)
};

// ── Níveis de Rigor ───────────────────────────────────────────
const AGGRESSIVENESS_THRESHOLDS = {
    conservative: { fluffScore: 0.72, redundancySim: 0.50, minParagraphs: 4 },
    balanced:     { fluffScore: 0.55, redundancySim: 0.38, minParagraphs: 3 },
    aggressive:   { fluffScore: 0.40, redundancySim: 0.28, minParagraphs: 2 },
};

// ══════════════════════════════════════════════════════════════
//  SEÇÃO 1 — DIVISOR DE PARÁGRAFOS
// ══════════════════════════════════════════════════════════════

/**
 * Divide o texto em frases individuais com inteligência para
 * não quebrar em abreviações (Sr., Dr., etc.), reticências (...) ou aspas.
 */
function splitIntoSentences(text) {
    if (!text || !text.trim()) return [];

    const abbr = /(?:Mr|Mrs|Ms|Dr|Prof|Sr|Sra|Srta|Jr|vs|etc|ex|approx|i\.e|e\.g|a\.m|p\.m|vol|dept|inc|ltd|corp|no|fig|obs)\./i;
    const sentences = [];
    let current = '';
    let i = 0;

    while (i < text.length) {
        const ch = text[i];
        current += ch;

        // Reticências (...) — não divide
        if (ch === '.' && text[i + 1] === '.' && text[i + 2] === '.') {
            current += text[i + 1] + text[i + 2];
            i += 3;
            continue;
        }

        // Pontuação de fim de frase (. ! ?)
        if ((ch === '.' || ch === '!' || ch === '?') && i + 1 < text.length) {
            let nextIdx = i + 1;
            const nextCh = text[nextIdx];

            // Inclui aspas de fechamento se houver
            if (nextCh === '"' || nextCh === '\u201D' || nextCh === "'" || nextCh === '\u2019' || nextCh === '»') {
                current += nextCh;
                nextIdx++;
            }

            if (nextIdx < text.length) {
                const afterCh = text[nextIdx];
                if (afterCh === ' ' || afterCh === '\n' || afterCh === '\r') {
                    const lastWord = current.trimEnd().split(/\s+/).pop() || '';
                    if (!abbr.test(lastWord)) {
                        sentences.push(current.trim());
                        current = '';
                        i = nextIdx + 1;
                        continue;
                    }
                }
            }
        }
        i++;
    }

    if (current.trim()) sentences.push(current.trim());
    return sentences;
}

/** Verifica se a frase começa com fala/diálogo (aspas ou travessão). */
function isDialogueLine(sentence) {
    return /^[""\u201C\u201D'«—–-]/.test(sentence.trim());
}

/** Divide um único parágrafo longo em sub-parágrafos menores. */
function breakParagraph(paragraph, settings) {
    const maxSent = settings.maxSentences || 4;
    const maxChars = settings.maxCharacters || 500;
    const sentences = splitIntoSentences(paragraph);

    if (sentences.length <= maxSent && paragraph.length <= maxChars) {
        return [paragraph];
    }

    const result = [];
    let bucket = [];
    let bucketLen = 0;

    for (const sentence of sentences) {
        // Se a fala de diálogo deve ficar separada
        if (settings.splitDialogue && isDialogueLine(sentence) && bucket.length > 0) {
            result.push(bucket.join(' '));
            bucket = [];
            bucketLen = 0;
        }

        bucket.push(sentence);
        bucketLen += sentence.length;

        if (bucket.length >= maxSent || bucketLen >= maxChars) {
            result.push(bucket.join(' '));
            bucket = [];
            bucketLen = 0;
        }
    }

    if (bucket.length > 0) {
        const remaining = bucket.join(' ');
        // Evita deixar frase órfã muito curta (< 80 caracteres)
        if (bucket.length === 1 && remaining.length < 80 && result.length > 0) {
            result[result.length - 1] += ' ' + remaining;
        } else {
            result.push(remaining);
        }
    }

    return result;
}

// ══════════════════════════════════════════════════════════════
//  SEÇÃO 2 — CORTADOR DE ENCHEÇÃO (FLUFF TRIMMER)
// ══════════════════════════════════════════════════════════════

// Palavras neutras ignoradas na análise (inglês + português)
const STOP_WORDS = new Set([
    'a','an','the','and','or','but','in','on','at','to','for','of','with','by','from','as',
    'is','was','are','were','be','been','being','have','has','had','do','does','did','will',
    'would','could','should','that','this','these','those','it','its','he','she','we','they',
    'o','os','a','as','um','uma','uns','umas','de','do','da','dos','das','em','no','na','nos','nas',
    'por','pelo','pela','pelos','pelas','com','sem','sob','sobre','para','pra','pro','e','ou','mas',
    'que','se','quando','onde','como','porque','porquê','já','ainda','mais','menos','muito','pouco',
    'ele','ela','eles','elas','eu','tu','você','vocês','nós','meu','minha','seu','sua','dele','dela',
    'era','estava','estavam','foi','foram','ser','estar','ter','havia','tinha','tinham','sido',
]);

// Vocabulário de ambiente / cenário (Inglês e Português)
const ATMOSPHERIC_WORDS = new Set([
    // Natureza e Clima
    'breeze','wind','gust','air','atmosphere','sky','skies','horizon','sunset','sunrise',
    'dawn','dusk','twilight','moonlight','starlight','sunlight','daylight','nightfall',
    'shadow','shadows','darkness','dark','dim','light','glow','glimmer','shimmer','sparkle',
    'rain','drizzle','storm','thunder','lightning','fog','mist','haze','clouds','overcast',
    'snow','frost','ice','cold','chill','warmth','warm','heat','humid',
    'silence','silent','quiet','stillness','still','calm','peaceful','serene','tranquil',
    'forest','trees','leaves','ocean','sea','waves','river','stream',
    // Português: Ambiente e Clima
    'brisa','vento','ventania','ar','atmosfera','céu','céus','horizonte','pôr','amanhecer',
    'anoitecer','alvorada','crepúsculo','luar','lua','sol','luz','luzes','solar',
    'sombra','sombras','escuridão','escuro','penumbra','brilho','raios','dourado','dourada',
    'chuva','chuvisco','tempestade','trovão','relâmpago','neblina','névoa','nuvens','nublado',
    'frio','gélido','gelado','calor','morno','quente','umidade','úmido',
    'silêncio','silencioso','quietude','calma','calmaria','paz','sereno','tranquilo',
    'floresta','árvores','folhas','folhagem','mar','ondas','oceano','rio','riacho',
    // Sensações e Verbos de Encheção
    'scent','smell','aroma','fragrance','whisper','murmur','echo','echoes','rustle',
    'tension','heaviness','heavy','melancholy','solitude','foreboding','eeriness',
    'seemed','appeared','lingered','loomed','enveloped','stretched','bathed','permeated',
    'danced','flickered','crept','drifted','hung','clung',
    // Português: Sensações e Verbos descritivos
    'cheiro','aroma','fragrância','perfume','odor','eco','ecos','sussurro','sussurros',
    'tensão','peso','pesado','melancolia','solidão','presságio','inquietude',
    'parecia','aparentava','pairava','estendia','envolvia','banhava','dançavam','dançava',
    'escorria','preenchia','repousava','ecoava','soprava','farfalhar','farfalhavam',
]);

// Padrões de frases que costumam ser pura encheção de linguiça
const FILLER_PATTERNS = [
    // Inglês
    /the\s+(air|atmosphere|room|space|silence|world|night|day|morning|evening|moment)\s+(seemed|felt|was|appeared|hung|lingered|grew|remained)/i,
    /a\s+(heavy|thick|palpable|tangible|subtle|faint|gentle|soft|delicate|quiet|oppressive|comfortable)\s+(silence|stillness|tension|calm|quiet|breeze|wind)/i,
    /(shadows|darkness|light|moonlight|sunlight|starlight)\s+(danced|played|flickered|crept|crawled|stretched|fell)/i,
    /time\s+(seemed|appeared|felt)\s+(to|like|as\s+if)\s+(slow|stop|freeze|stand|stretch)/i,
    // Português
    /o\s+(ar|ambiente|quarto|espaço|silêncio|mundo|momento)\s+(parecia|estava|ficou|pairava|pesava)/i,
    /um(a)?\s+(pesado|espesso|palpável|sutil|suave|delicado|opressivo|confortável)?\s*(silêncio|calmaria|tensão|brisa|vento)/i,
    /(sombras|escuridão|luz|luar|luz\s+do\s+sol)\s+(dançavam|brincavam|alongavam|escorriam|rastejavam)/i,
    /o\s+tempo\s+(parecia|aparentava)\s+(ter\s+parado|congelar|desacelerar|se\s+arrastar)/i,
    /ao\s+(longe|fundo|redor),?\s*(o|a|os|as)\s*(vento|som|silêncio|eco|sol|lua)/i,
];

// Verbos de ação da história (parágrafos com eles NUNCA são apagados)
const ACTION_VERBS = new Set([
    // Inglês
    'said','asked','replied','answered','shouted','whispered','muttered','smiled','laughed',
    'frowned','nodded','shook','grabbed','pulled','pushed','threw','held','ran','walked',
    'stepped','moved','turned','opened','closed','kissed','hugged','stood','sat',
    // Português
    'disse','perguntou','respondeu','falou','gritou','sussurrou','murmurou','sorriu','riu',
    'franziu','acenou','balançou','pegou','puxou','empurrou','jogou','segurou','correu',
    'andou','caminhou','passou','virou','abriu','fechou','beijou','abraçou','levantou',
    'sentou','olhou','encarou','avançou','recuou','tocou','largou','tirou','colocou',
]);

function extractSignificantWords(text) {
    return text
        .toLowerCase()
        .replace(/[^a-zà-ú\s'-]/gi, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function jaccardSimilarity(wordsA, wordsB) {
    const setA = new Set(wordsA);
    const setB = new Set(wordsB);
    if (setA.size === 0 && setB.size === 0) return 0;

    let intersection = 0;
    for (const w of setA) {
        if (setB.has(w)) intersection++;
    }
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : intersection / union;
}

function scoreParagraphFluff(paragraph) {
    const text = paragraph.trim();
    const words = extractSignificantWords(text);
    const wordSet = new Set(words);
    const totalWords = words.length;

    // Detecta falas
    const hasDialogue = /[""\u201C\u201D'«—–-]/.test(text);
    const isDialogueParagraph = /^[""\u201C\u201D'«—–-]/.test(text);

    // Detecta ações
    let actionCount = 0;
    for (const w of wordSet) {
        if (ACTION_VERBS.has(w)) actionCount++;
    }
    const hasAction = actionCount > 0;

    // Densidade de palavras de cenário
    let atmosphericCount = 0;
    for (const w of words) {
        if (ATMOSPHERIC_WORDS.has(w)) atmosphericCount++;
    }
    const atmosphericDensity = totalWords > 0
        ? Math.min(1, atmosphericCount / totalWords * 2.5)
        : 0;

    // Padrões de encheção
    let patternMatches = 0;
    for (const pattern of FILLER_PATTERNS) {
        if (pattern.test(text)) patternMatches++;
    }
    const patternScore = Math.min(1, patternMatches / 3);

    const noDialogueScore = hasDialogue ? 0 : 1;
    const noActionScore = hasAction ? 0 : 1;
    const isShortFiller = totalWords > 0 && totalWords <= 12 && !hasDialogue && !hasAction;
    const shortBonus = isShortFiller ? 1 : 0;

    const score =
        (atmosphericDensity * 0.30) +
        (patternScore       * 0.30) +
        (noDialogueScore    * 0.15) +
        (noActionScore      * 0.15) +
        (shortBonus         * 0.10);

    return {
        score: Math.min(1, score),
        isDialogue: hasDialogue || isDialogueParagraph,
        isAction: hasAction,
        words,
    };
}

function trimFluff(paragraphs, settings) {
    if (!paragraphs || paragraphs.length <= 2) {
        return { paragraphs, trimmedCount: 0 };
    }

    const level = settings.fluffAggressiveness || 'balanced';
    const thresholds = AGGRESSIVENESS_THRESHOLDS[level] || AGGRESSIVENESS_THRESHOLDS.balanced;
    const maxAtmo = settings.maxAtmosphericParagraphs ?? 1;
    const protectDialogue = settings.protectDialogue !== false;

    const analyzed = paragraphs.map((p, idx) => {
        const analysis = scoreParagraphFluff(p);
        return {
            text: p,
            index: idx,
            ...analysis,
            isProtected: false,
            isFluff: false,
            redundancyScore: 0,
        };
    });

    // 1. Proteger falas e ações
    for (const entry of analyzed) {
        if (protectDialogue && entry.isDialogue) {
            entry.isProtected = true;
            continue;
        }
        if (entry.isAction) {
            entry.isProtected = true;
            continue;
        }
        const t = entry.text.trim();
        if (
            t.startsWith('```') || t.startsWith('> ') ||
            t.startsWith('- ') || t.startsWith('* ') ||
            /^\d+\.\s/.test(t) || t.startsWith('#') ||
            t.startsWith('---') || t.startsWith('___')
        ) {
            entry.isProtected = true;
        }
    }

    // 2. Identificar candidatos a encheção
    const fluffCandidates = [];
    for (const entry of analyzed) {
        if (entry.isProtected) continue;
        if (entry.score >= thresholds.fluffScore) {
            entry.isFluff = true;
            fluffCandidates.push(entry);
        }
    }

    if (fluffCandidates.length === 0) {
        return { paragraphs, trimmedCount: 0 };
    }

    // 3. Similaridade e redundância
    for (const candidate of fluffCandidates) {
        let maxSim = 0;
        for (const other of analyzed) {
            if (other.index === candidate.index) continue;
            if (other.words.length === 0) continue;
            const sim = jaccardSimilarity(candidate.words, other.words);
            if (sim > maxSim) maxSim = sim;
        }
        candidate.redundancyScore = maxSim;
    }

    // 4. Se for no começo ou no final da resposta, ganha prioridade de corte
    if (settings.trimBookends) {
        for (const candidate of fluffCandidates) {
            const isBookend = candidate.index === 0 ||
                              candidate.index === paragraphs.length - 1 ||
                              candidate.index === 1 ||
                              candidate.index === paragraphs.length - 2;
            if (isBookend) {
                candidate.score = Math.min(1, candidate.score + 0.08);
                candidate.redundancyScore = Math.min(1, candidate.redundancyScore + 0.05);
            }
        }
    }

    fluffCandidates.sort((a, b) => {
        const compA = a.score * 0.6 + a.redundancyScore * 0.4;
        const compB = b.score * 0.6 + b.redundancyScore * 0.4;
        return compB - compA;
    });

    const toRemove = new Set();
    let atmosphericKept = 0;

    for (const entry of analyzed) {
        if (entry.isProtected && entry.score >= thresholds.fluffScore * 0.7) {
            atmosphericKept++;
        }
    }

    for (const candidate of fluffCandidates) {
        const remainingCount = paragraphs.length - toRemove.size;
        if (remainingCount <= thresholds.minParagraphs) break;

        if (atmosphericKept < maxAtmo) {
            atmosphericKept++;
            continue;
        }

        if (candidate.redundancyScore >= thresholds.redundancySim || candidate.score >= thresholds.fluffScore + 0.15) {
            toRemove.add(candidate.index);
        }
    }

    if (toRemove.size === 0) {
        return { paragraphs, trimmedCount: 0 };
    }

    const result = paragraphs.filter((_, idx) => !toRemove.has(idx));
    console.log(
        `${LOG_PREFIX} [Cortador] Cortou ${toRemove.size} parágrafo(s) de encheção repetitiva.`
    );

    return { paragraphs: result, trimmedCount: toRemove.size };
}

// ══════════════════════════════════════════════════════════════
//  SEÇÃO 3 — PROCESSAMENTO DA MENSAGEM
// ══════════════════════════════════════════════════════════════

function processMessageText(messageText, settings) {
    if (!messageText || !messageText.trim()) return messageText;

    const rawParagraphs = messageText.split(/\n{2,}/);
    let processed = [];

    // Fase 1: Divisão de parágrafos
    for (const para of rawParagraphs) {
        const trimmed = para.trim();
        if (!trimmed) continue;

        if (
            trimmed.startsWith('```') ||
            trimmed.startsWith('> ') ||
            trimmed.startsWith('- ') ||
            trimmed.startsWith('* ') ||
            /^\d+\.\s/.test(trimmed) ||
            trimmed.startsWith('#') ||
            trimmed.startsWith('---') ||
            trimmed.startsWith('___') ||
            trimmed.startsWith('***')
        ) {
            processed.push(trimmed);
            continue;
        }

        const isWrappedAction = /^\*[^*]/.test(trimmed) && /[^*]\*$/.test(trimmed);

        if (settings.enabled) {
            if (isWrappedAction && settings.preserveFormatting) {
                const inner = trimmed.slice(1, -1);
                const subs = breakParagraph(inner, settings);
                for (const sub of subs) {
                    processed.push('*' + sub + '*');
                }
            } else {
                const subs = breakParagraph(trimmed, settings);
                processed.push(...subs);
            }
        } else {
            processed.push(trimmed);
        }
    }

    // Fase 2: Cortador de Encheção
    let trimmedCount = 0;
    if (settings.fluffTrimmerEnabled && processed.length > 2) {
        const result = trimFluff(processed, settings);
        processed = result.paragraphs;
        trimmedCount = result.trimmedCount;
    }

    let output = processed.join('\n\n');

    if (trimmedCount > 0 && settings.showTrimmedIndicator) {
        console.log(`${LOG_PREFIX} ${trimmedCount} parágrafo(s) de encheção foram enxugados.`);
    }

    return output;
}

// ══════════════════════════════════════════════════════════════
//  SEÇÃO 4 — EVENTOS DO SILLYTAVERN
// ══════════════════════════════════════════════════════════════

function onMessageReceived(messageIndex) {
    const settings = extension_settings[MODULE_NAME];
    if (!settings) return;
    if (!settings.enabled && !settings.fluffTrimmerEnabled) return;

    try {
        const context = SillyTavern.getContext();
        const message = context.chat[messageIndex];
        if (!message || message.is_user) return;

        const original = message.mes;
        const processed = processMessageText(original, settings);

        if (processed !== original) {
            message.mes = processed;
            console.log(
                `${LOG_PREFIX} Mensagem #${messageIndex} otimizada: ` +
                `${original.length} → ${processed.length} caracteres.`
            );
        }
    } catch (err) {
        console.error(`${LOG_PREFIX} Erro ao processar mensagem #${messageIndex}:`, err);
    }
}

function reprocessAllMessages() {
    const settings = extension_settings[MODULE_NAME];
    if (!settings) return;

    try {
        const context = SillyTavern.getContext();
        const chat = context.chat;
        let count = 0;

        for (let i = 0; i < chat.length; i++) {
            const message = chat[i];
            if (!message || message.is_user) continue;

            const original = message.mes;
            const processed = processMessageText(original, settings);

            if (processed !== original) {
                message.mes = processed;
                count++;
            }
        }

        if (count > 0) {
            saveChatDebounced();
            context.reloadCurrentChat?.();
            toastr.success(
                `${count} mensagem(ns) ajustada(s) com sucesso!`,
                'Divisor de Parágrafos'
            );
        } else {
            toastr.info(
                'Nenhuma mensagem precisou de corte ou divisão.',
                'Divisor de Parágrafos'
            );
        }

        console.log(`${LOG_PREFIX} ${count} mensagens foram reprocessadas`);
    } catch (err) {
        console.error(`${LOG_PREFIX} Erro ao reprocessar mensagens:`, err);
        toastr.error('Erro ao reprocessar. Abra o console (F12).', 'Divisor de Parágrafos');
    }
}

// ══════════════════════════════════════════════════════════════
//  SEÇÃO 5 — INTERFACE VISUAL EM PORTUGUÊS
// ══════════════════════════════════════════════════════════════

function loadSettings() {
    extension_settings[MODULE_NAME] = Object.assign(
        {},
        DEFAULT_SETTINGS,
        extension_settings[MODULE_NAME] || {}
    );
    return extension_settings[MODULE_NAME];
}

function updateSettingsUI() {
    const s = extension_settings[MODULE_NAME];
    // Divisor
    $('#pb_enabled').prop('checked', s.enabled);
    $('#pb_split_dialogue').prop('checked', s.splitDialogue);
    $('#pb_preserve_formatting').prop('checked', s.preserveFormatting);
    $('#pb_max_sentences').val(s.maxSentences);
    $('#pb_max_sentences_val').text(s.maxSentences);
    $('#pb_max_characters').val(s.maxCharacters);
    $('#pb_max_characters_val').text(s.maxCharacters);

    // Cortador
    $('#ft_enabled').prop('checked', s.fluffTrimmerEnabled);
    $('#ft_aggressiveness').val(s.fluffAggressiveness);
    $('#ft_max_atmospheric').val(s.maxAtmosphericParagraphs);
    $('#ft_max_atmospheric_val').text(s.maxAtmosphericParagraphs);
    $('#ft_trim_bookends').prop('checked', s.trimBookends);
    $('#ft_protect_dialogue').prop('checked', s.protectDialogue);
    $('#ft_show_indicator').prop('checked', s.showTrimmedIndicator);
}

function saveSetting(key, value) {
    extension_settings[MODULE_NAME][key] = value;
    saveMetadataDebounced();
    console.log(`${LOG_PREFIX} Configuração salva: "${key}" → ${JSON.stringify(value)}`);
}

function renderSettingsUI() {
    const html = `
    <div id="paragraph_breaker_settings" class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b><i class="fa-solid fa-paragraph"></i> Divisor de Parágrafos + Cortador de Encheção</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" style="display: none;">

            <!-- ═══ SEÇÃO: DIVISOR DE PARÁGRAFOS ═══ -->
            <div class="pb-section-title">
                <i class="fa-solid fa-scissors"></i> Divisor de Parágrafos
            </div>

            <label title="Ativa a divisão automática de blocos longos de texto">
                <input type="checkbox" id="pb_enabled" />
                <span>Ativar Divisor de Parágrafos</span>
            </label>

            <label title="Separa falas com aspas ou travessão em parágrafos próprios">
                <input type="checkbox" id="pb_split_dialogue" />
                <span>Separar falas/diálogos em parágrafos próprios</span>
            </label>

            <label title="Mantém itálicos (*texto*) e negritos (**texto**) intactos ao quebrar">
                <input type="checkbox" id="pb_preserve_formatting" />
                <span>Preservar formatação markdown</span>
            </label>

            <div class="pb-slider-group">
                <label>Máximo de frases por parágrafo</label>
                <div class="pb-slider-row">
                    <input type="range" id="pb_max_sentences" min="2" max="10" step="1" />
                    <span class="pb-slider-value" id="pb_max_sentences_val">4</span>
                </div>
            </div>

            <div class="pb-slider-group">
                <label>Máximo de caracteres por parágrafo</label>
                <div class="pb-slider-row">
                    <input type="range" id="pb_max_characters" min="200" max="1200" step="50" />
                    <span class="pb-slider-value" id="pb_max_characters_val">500</span>
                </div>
            </div>

            <hr class="pb-divider" />

            <!-- ═══ SEÇÃO: CORTADOR DE ENCHEÇÃO DE LINGUIÇA ═══ -->
            <div class="pb-section-title">
                <i class="fa-solid fa-broom"></i> Cortador de Encheção de Linguiça
            </div>

            <div class="pb-info ft-info-top">
                <i class="fa-solid fa-circle-info"></i>
                Identifica e remove parágrafos repetitivos de "clima e cenário"
                que a IA fica colocando no início e no fim da mensagem (ex:
                descrever o vento ou pôr do sol repetidamente), sem deixar o texto seco!
            </div>

            <label title="Ativa a remoção de parágrafos repetitivos de clima/cenário">
                <input type="checkbox" id="ft_enabled" />
                <span>Ativar Cortador de Encheção</span>
            </label>

            <div class="pb-slider-group">
                <label>Nível de Rigor (Agressividade do corte)</label>
                <select id="ft_aggressiveness" class="text_pole">
                    <option value="conservative">🟢 Conservador — corta apenas o excesso óbvio</option>
                    <option value="balanced">🟡 Equilibrado — ideal para o dia a dia</option>
                    <option value="aggressive">🔴 Agressivo — foca 100% na ação e diálogo</option>
                </select>
            </div>

            <div class="pb-slider-group">
                <label>Quantos parágrafos de ambiente manter (por mensagem)</label>
                <div class="pb-slider-row">
                    <input type="range" id="ft_max_atmospheric" min="0" max="4" step="1" />
                    <span class="pb-slider-value" id="ft_max_atmospheric_val">1</span>
                </div>
            </div>

            <label title="Analisa com mais rigor o 1º e o último parágrafo da resposta (onde a IA mais enche linguiça)">
                <input type="checkbox" id="ft_trim_bookends" />
                <span>Priorizar cortes no início e final da mensagem</span>
            </label>

            <label title="Nunca apagar parágrafos onde os personagens estão conversando">
                <input type="checkbox" id="ft_protect_dialogue" />
                <span>Sempre proteger parágrafos com falas</span>
            </label>

            <label title="Registra no console do navegador (F12) o que foi cortado">
                <input type="checkbox" id="ft_show_indicator" />
                <span>Mostrar avisos de corte no Console (F12)</span>
            </label>

            <hr class="pb-divider" />

            <!-- ═══ BOTÃO DE AÇÃO ═══ -->
            <button id="pb_reprocess_btn" class="menu_button" title="Reprocessa e formata todas as mensagens já existentes nesta conversa">
                <i class="fa-solid fa-arrows-rotate"></i> Reprocessar Conversa Atual
            </button>

            <div class="pb-info">
                <i class="fa-solid fa-circle-info"></i>
                As alterações funcionam <b>automaticamente</b> para cada nova mensagem da IA.
                Clique no botão acima se quiser arrumar as mensagens antigas que já foram enviadas.
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);

    // Binds de Eventos — Divisor
    $('#pb_enabled').on('change', function () {
        saveSetting('enabled', $(this).prop('checked'));
    });
    $('#pb_split_dialogue').on('change', function () {
        saveSetting('splitDialogue', $(this).prop('checked'));
    });
    $('#pb_preserve_formatting').on('change', function () {
        saveSetting('preserveFormatting', $(this).prop('checked'));
    });
    $('#pb_max_sentences').on('input', function () {
        const val = parseInt($(this).val(), 10);
        $('#pb_max_sentences_val').text(val);
        saveSetting('maxSentences', val);
    });
    $('#pb_max_characters').on('input', function () {
        const val = parseInt($(this).val(), 10);
        $('#pb_max_characters_val').text(val);
        saveSetting('maxCharacters', val);
    });

    // Binds de Eventos — Cortador
    $('#ft_enabled').on('change', function () {
        saveSetting('fluffTrimmerEnabled', $(this).prop('checked'));
    });
    $('#ft_aggressiveness').on('change', function () {
        saveSetting('fluffAggressiveness', $(this).val());
    });
    $('#ft_max_atmospheric').on('input', function () {
        const val = parseInt($(this).val(), 10);
        $('#ft_max_atmospheric_val').text(val);
        saveSetting('maxAtmosphericParagraphs', val);
    });
    $('#ft_trim_bookends').on('change', function () {
        saveSetting('trimBookends', $(this).prop('checked'));
    });
    $('#ft_protect_dialogue').on('change', function () {
        saveSetting('protectDialogue', $(this).prop('checked'));
    });
    $('#ft_show_indicator').on('change', function () {
        saveSetting('showTrimmedIndicator', $(this).prop('checked'));
    });

    $('#pb_reprocess_btn').on('click', reprocessAllMessages);
}

// ══════════════════════════════════════════════════════════════
//  SEÇÃO 6 — INICIALIZAÇÃO
// ══════════════════════════════════════════════════════════════

jQuery(async () => {
    console.log(`${LOG_PREFIX} Inicializando v1.2.0 (PT-BR)...`);

    loadSettings();
    renderSettingsUI();
    updateSettingsUI();

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);

    eventSource.on(event_types.CHAT_CHANGED, () => {
        const settings = extension_settings[MODULE_NAME];
        if (settings?.processExisting && (settings?.enabled || settings?.fluffTrimmerEnabled)) {
            setTimeout(() => reprocessAllMessages(), 500);
        }
    });

    console.log(`${LOG_PREFIX} Extensão carregada com sucesso! ✅`);
    toastr.info('Divisor de Parágrafos + Cortador de Encheção pronto!', 'Extensão Ativa', { timeOut: 2500 });
});
