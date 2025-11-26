const express = require('express');
const multer = require('multer');
const path = require('path');
const cheerio = require('cheerio');
const fs = require('fs');
const pdfParse = require('pdf-parse');

const app = express();
const port = process.env.PORT || 10000;

// === storage for multer: simple disk storage in uploads/ ===
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const name = Date.now() + '-' + file.originalname.replace(/\s+/g, '_');
    cb(null, name);
  }
});
const upload = multer({ storage }).single('pdf'); // IMPORTANT: field name 'pdf'

// keep last uploaded lecture text in memory (per "session")
let LECTURE_TEXT = ''; // full text of last uploaded PDF

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/static', express.static(path.join(__dirname, 'public')));
app.use('/', express.static(path.join(__dirname, 'public')));

// ---------- utility functions ----------
function normalizeText(s) {
  if (!s) return '';
  return s
    .replace(/\s+/g, ' ')
    .replace(/[«»"“”'`·•]/g, '')
    .trim()
    .toLowerCase();
}

function tokenize(s) {
  s = normalizeText(s);
  // basic Russian stopwords — small list
  const stop = new Set(['и','в','во','не','на','по','что','как','к','с','за','из','это','то','а','з','—','…','для','при','от','или','его','ее','она','он','они','быть','есть','бы']);
  return s.split(/\s+/).filter(t => t && !stop.has(t));
}

function uniqStrings(arr) {
  const seen = new Set();
  const out = [];
  for (const a of arr) {
    const n = a.trim();
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

// find sentences in lecture that contain token overlap
function splitToSentences(text) {
  // simple sentence split by .,!?; newline — robust enough
  return text.split(/(?<=[.!?;])\s+|\n+/).map(s => s.trim()).filter(Boolean);
}

function scoreSentenceAgainstTokens(sentence, tokens) {
  const sTokens = new Set(tokenize(sentence));
  if (!tokens.length) return 0;
  let common = 0;
  tokens.forEach(t => { if (sTokens.has(t)) common++; });
  return common / tokens.length; // fraction matched
}

// main matching procedure — returns matched snippet(s) and score
function findBestMatchesForOption(pdfSentences, optionText, questionTokens) {
  const optTokens = tokenize(optionText);
  // for each sentence compute combined score: overlap with option + overlap with question
  const results = pdfSentences.map(s => {
    const sNorm = s;
    const scoreOpt = scoreSentenceAgainstTokens(sNorm, optTokens);
    const scoreQ = scoreSentenceAgainstTokens(sNorm, questionTokens);
    // weigh option matches more (we want text supporting option)
    const score = scoreOpt * 0.7 + scoreQ * 0.3;
    return { sentence: sNorm, score, scoreOpt, scoreQ };
  });
  // sort by score desc
  results.sort((a,b) => b.score - a.score);
  // return top N non-empty
  const top = results.filter(r => r.score > 0).slice(0, 3);
  return top;
}

// try to answer short answer by definitions in PDF like "X - это ..." or "X — это ..."
function findShortAnswer(pdfText, questionText) {
  const sentences = splitToSentences(pdfText);
  // look for pattern "<term> - это" or "<term> — это" at sentence start
  for (const s of sentences) {
    const m = s.match(/^(.{1,60}?)\s*[-—–:]\s*это\b/i);
    if (m) {
      let term = m[1].trim();
      // remove trailing stopwords/punctuation
      term = term.replace(/[:;,.!?]$/,'').trim();
      if (term) return { answer: term, snippet: s };
    }
  }
  // fallback: search for phrase "это <something> - " and try to extract following noun
  // e.g. "Статическое электричество - это совокупность явлений..."
  // alternatively look for lines that contain question keywords and nearby noun
  return null;
}

// parse HTML to questions array
function parseQuizHtml(html) {
  const $ = cheerio.load(html);
  const questions = [];
  // each question block in Moodle uses class .que or element id starting with "question-"
  $('div.que').each((i, el) => {
    const q = {};
    const $el = $(el);
    // question text
    const qtext = $el.find('.qtext').text().trim();
    q.text = qtext || $el.find('h4').text().trim() || `Вопрос ${i+1}`;
    // detect short answer (has input[type=text]) or multichoice (has inputs checkboxes/radios)
    const inputs = $el.find('input');
    const textInput = $el.find('input[type="text"], textarea').first();
    if (textInput.length) {
      q.type = 'shortanswer';
      q.options = []; // no options
    } else {
      q.type = 'multichoice';
      // collect visible option labels
      const opts = [];
      // Moodle wraps options with .answer or labels; try to get meaningful texts
      $el.find('.answer .r0, .answer .r1, li, .answer > div').each((ii, op) => {
        const optText = $(op).text().replace(/\s+/g,' ').trim();
        if (optText) opts.push(optText);
      });
      // fallback: find inputs and their aria-labelledby
      if (!opts.length) {
        $el.find('input[type="checkbox"], input[type="radio"]').each((ii, inp) => {
          const id = $(inp).attr('id');
          let label = '';
          if (id) label = $(`[id="${id}_label"]`).text().trim();
          if (!label) label = $(`label[for="${id}"]`).text().trim();
          if (label) opts.push(label);
        });
      }
      // final clean and dedupe
      q.options = uniqStrings(opts.map(s => s.replace(/\s+/g,' ').trim()));
    }
    questions.push(q);
  });
  // If no .que found (different markup), fallback: scan for <fieldset> with legend "Ответ"
  if (!questions.length) {
    $('fieldset').each((i, el) => {
      const q = {};
      const $el = $(el);
      const qtext = $el.prevAll('.qtext').first().text().trim() || $el.prev('p').text().trim();
      q.text = qtext || `Вопрос ${i+1}`;
      const options = [];
      $el.find('p, div').each((ii, op) => {
        const t = $(op).text().trim();
        if (t) options.push(t);
      });
      if (options.length) {
        q.type = 'multichoice';
        q.options = uniqStrings(options);
      } else {
        q.type = 'shortanswer';
        q.options = [];
      }
      questions.push(q);
    });
  }
  return questions;
}

// ---------- routes ----------

// upload PDF and parse to LECTURE_TEXT
app.post('/upload-pdf', (req, res) => {
  upload(req, res, async function(err) {
    if (err) {
      console.error('Upload error', err);
      return res.status(400).json({ ok: false, error: String(err) });
    }
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file' });
    try {
      const dataBuffer = fs.readFileSync(req.file.path);
      const pdfData = await pdfParse(dataBuffer);
      const text = pdfData.text || '';
      LECTURE_TEXT = text;
      // optionally remove file to save disk
      try { fs.unlinkSync(req.file.path); } catch(e){}
      return res.json({ ok: true, textSnippet: text.slice(0, 1000) });
    } catch (e) {
      console.error('pdf parse error', e);
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });
});

// process quiz HTML: parse questions and attempt to find answers using LECTURE_TEXT
app.post('/process-quiz', (req, res) => {
  const { html } = req.body;
  if (!html) return res.status(400).json({ error: 'No html provided' });
  if (!LECTURE_TEXT) return res.status(400).json({ error: 'Upload PDF first' });

  const pdfText = LECTURE_TEXT;
  const pdfSentences = splitToSentences(pdfText);

  const questions = parseQuizHtml(html);

  const results = questions.map((q) => {
    const qTokens = tokenize(q.text);
    if (q.type === 'shortanswer') {
      // try to find definition pattern
      const def = findShortAnswer(pdfText, q.text);
      if (def) {
        return {
          type: q.type,
          question: q.text,
          answer: def.answer,
          confidence: 0.95,
          snippet: def.snippet
        };
      }
      // fallback: search sentences that contain many question tokens and return a short phrase from sentence
      const scored = pdfSentences.map(s => ({ s, score: scoreSentenceAgainstTokens(s, qTokens) }));
      scored.sort((a,b) => b.score - a.score);
      const best = scored[0];
      if (best && best.score > 0) {
        // attempt to extract a candidate word: find pattern "— это" or "- это"
        const m = best.s.match(/([А-ЯЁA-Я][А-Яа-яё\-]{2,40})\s*[-—–:]\s*это/i);
        const candidate = m ? m[1] : null;
        return {
          type: q.type,
          question: q.text,
          answer: candidate || best.s.slice(0, 60),
          confidence: candidate ? 0.9 : Math.min(0.7, best.score),
          snippet: best.s
        };
      }
      return { type: q.type, question: q.text, answer: null, confidence: 0, snippet: null };
    } else {
      // multichoice
      const opts = q.options || [];
      const optionResults = opts.map(opt => {
        const matches = findBestMatchesForOption(pdfSentences, opt, qTokens);
        let bestSnippet = matches.length ? matches[0].sentence : '';
        let bestScore = matches.length ? matches[0].score : 0;
        // also check exact substring presence (case-insensitive)
        const nOpt = normalizeText(opt);
        const exactFound = pdfText.toLowerCase().includes(nOpt);
        if (exactFound && bestScore < 0.5) bestScore = Math.max(bestScore, 0.6);
        return { option: opt, score: bestScore, foundSnippet: bestSnippet, matches };
      });

      // decide which to mark as correct:
      // heuristic: if one option has score >> others, pick it (single-best)
      // if several have high scores >=0.5, pick them all (multi-select)
      const scores = optionResults.map(o => o.score);
      const maxScore = Math.max(...scores, 0);
      let chosen = [];
      if (maxScore >= 0.55) {
        // choose all with score >= 0.55
        chosen = optionResults.filter(o => o.score >= 0.55);
      } else if (maxScore >= 0.35) {
        // if multiple close to max, choose those within 0.15 of max
        chosen = optionResults.filter(o => (maxScore - o.score) <= 0.15 && o.score > 0.25);
        if (!chosen.length) {
          chosen = optionResults.sort((a,b)=>b.score-a.score).slice(0,1);
        }
      } else {
        // low confidence: choose top1 if any small signal
        const top = optionResults.sort((a,b)=>b.score-a.score)[0];
        if (top && top.score > 0.15) chosen = [top];
        else chosen = [];
      }

      // assemble result per option with highlight flag
      const annotatedOptions = optionResults.map(o => ({
        text: o.option,
        score: +(o.score.toFixed(3)),
        snippet: o.foundSnippet,
        predicted_correct: chosen.some(c => c.option === o.option)
      }));

      return {
        type: q.type,
        question: q.text,
        options: annotatedOptions
      };
    }
  });

  return res.json({ ok: true, results });
});

// small health
app.get('/health', (req, res) => res.json({ ok: true }));

// serve index
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
