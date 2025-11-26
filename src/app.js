const express = require('express');
const multer = require('multer');
const fs = require('fs');
const cheerio = require('cheerio');
const pdfParse = require('pdf-parse');
const path = require('path');

const app = express();
const port = process.env.PORT || 10000;

let pdfText = ""; // нормализованный текст лекции (lowercase, punctuation removed)

const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// ---------------- utilities ----------------
function normalize(s) {
  if (!s) return "";
  return s.toString()
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d«»]/g, '"')
    .replace(/[-–—−]/g, '-') // dashes
    .replace(/[^\w\s\-а-яё]/gi, ' ') // оставим буквы(рус/лат), цифры, тире и пробелы
    .replace(/\s+/g, ' ')
    .trim();
}

// простая нормализация для сравнения (без русской ё vs е проблем)
function norm(s){ return normalize(s).replace(/ё/g,'е'); }

// Levenshtein
function levenshtein(a,b){
  a = a || ''; b = b || '';
  const m = a.length, n = b.length;
  if(m===0) return n; if(n===0) return m;
  const dp = Array(n+1); for(let j=0;j<=n;j++) dp[j]=j;
  for(let i=1;i<=m;i++){
    let prev = dp[0]; dp[0]=i;
    for(let j=1;j<=n;j++){
      const tmp = dp[j];
      const cost = a[i-1]===b[j-1]?0:1;
      dp[j] = Math.min(dp[j]+1, dp[j-1]+1, prev+cost);
      prev = tmp;
    }
  }
  return dp[n];
}

function wordOverlap(a,b){
  const A = new Set(a.split(' ').filter(Boolean));
  const B = new Set(b.split(' ').filter(Boolean));
  if(!A.size || !B.size) return 0;
  let common = 0;
  for(const w of A) if(B.has(w)) common++;
  return common / Math.max(A.size, B.size);
}

function makeFragments(text){
  if(!text) return [];
  const lines = text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const fr = [];
  for(const l of lines){
    if(l.length>20) fr.push(l);
    const parts = l.split(/(?<=[.?!])\s+/);
    for(const p of parts){
      const t = p.trim();
      if(t.length>20) fr.push(t);
    }
  }
  if(fr.length===0 && text.length>0){
    (text.match(/.{1,200}/g)||[]).forEach(x=>fr.push(x));
  }
  return fr;
}

// check special category keywords (for this particular question)
function categoryMatch(option){
  // returns normalized 'повышенная','особо','без' or null
  const o = norm(option);
  if(/(?:без\s+повышен|безопасн|без\s+опас)/.test(o)) return 'без';
  if(/(?:особ|особо)/.test(o)) return 'особо';
  if(/(?:повышен|повышенн|повыш)/.test(o)) return 'повышенная';
  return null;
}

// check if pdf contains category phrases explicitly
function pdfHasCategory(cat){
  if(!pdfText) return false;
  if(cat==='повышенная' || cat==='повышен') {
    return /помещени[еия]\s+с\s+повышенн(?:ой|ая|ое|ые|ым|ому|их)|помещения\s+с\s+повышенной\s+опасностью|помещения\s+с\s+повышенной/.test(pdfText);
  }
  if(cat==='особо' || cat==='особ') {
    return /особо\s+опасн(?:ые|ая|ое)|особые\s+опасные|особоопасн/i.test(pdfText);
  }
  if(cat==='без') {
    return /помещени[еия]\s+без\s+повышенн(?:ой|ая|ое|ые)?\s+опасности|без\s+повышенной\s+опасности|без\s+опасности/i.test(pdfText);
  }
  return false;
}

// score option robustly
function scoreOption(option, fragments){
  const oNorm = norm(option);
  // 1. exact normalized substring
  if(oNorm.length>3 && pdfText.includes(oNorm)) return {score:1, evidence:oNorm, exact:true};

  // 2. category keyword strong match
  const cat = categoryMatch(option);
  if(cat && pdfHasCategory(cat)) {
    // evidence is the phrase from PDF that matched category
    return {score:0.98, evidence: cat, exact:false};
  }

  // 3. check by overlap with fragments and levenshtein
  let best = {score:0, evidence:''};
  for(const frag of fragments){
    const f = norm(frag);
    const overlap = wordOverlap(oNorm, f);
    const lev = levenshtein(oNorm.slice(0,200), f.slice(0,200));
    const normLev = 1 - Math.min(1, lev / Math.max(1, Math.max(oNorm.length, f.length)));
    const score = overlap*0.75 + normLev*0.25;
    if(score>best.score){ best = {score, evidence: frag}; }
  }
  return best;
}

// ---------------- routes ----------------
app.post('/upload-pdf', upload.single('pdf'), async (req,res) => {
  if(!req.file) return res.status(400).json({error:'No file'});
  try{
    const data = await fs.promises.readFile(req.file.path);
    const parsed = await pdfParse(data);
    // normalize PDF text once (lowercase, replace ё->е)
    pdfText = normalize(parsed.text || '').replace(/ё/g,'е');
    fs.unlink(req.file.path, ()=>{});
    return res.json({ok:true, message:'PDF parsed'});
  }catch(e){
    console.error(e);
    return res.status(500).json({error:'parse error'});
  }
});

app.post('/process-quiz', (req,res) => {
  const html = req.body.html;
  if(!html) return res.status(400).json({error:'HTML required'});
  const $ = cheerio.load(html);
  const fragments = makeFragments(pdfText);
  const results = [];

  // find question blocks (moodle .que) or fall back to .qtext
  const blocks = $('div.que').length ? $('div.que') : $('.qtext').parent();

  blocks.each((i, block) => {
    const qtextEl = $(block).find('.qtext').first();
    const question = qtextEl.text().trim() || `Вопрос ${i+1}`;

    // collect options but dedupe exact texts
    const optionSet = new Set();
    const options = [];

    const answerBlock = $(block).find('.answer').first();
    if(answerBlock.length){
      // prefer inputs/labels, then paragraphs, then divs
      answerBlock.find('label, p, div, span').each((j, el) => {
        const t = $(el).text().trim();
        if(t){
          const txt = t.replace(/\s+/g,' ').trim();
          if(!optionSet.has(txt)){
            optionSet.add(txt);
            options.push(txt);
          }
        }
      });
      // fallback: raw text split by lines
      if(options.length===0){
        const raw = answerBlock.text().trim();
        raw.split(/\r?\n/).map(s=>s.trim()).filter(Boolean).forEach(s=>{
          const txt = s.replace(/\s+/g,' ').trim();
          if(!optionSet.has(txt)){ optionSet.add(txt); options.push(txt); }
        });
      }
    }

    if(options.length>0){
      // score each option and decide correctness
      const scored = options.map(opt => {
        const r = scoreOption(opt, fragments);
        const threshold = r.exact ? 0.9 : 0.55; // чуть повышенный порог
        return {
          text: opt,
          score: Number((r.score||0).toFixed(3)),
          correct: (r.score||0) >= threshold,
          evidence: r.evidence || ''
        };
      });

      // If none marked correct but pdfText clearly contains categories, fallback: mark matching categories
      const anyCorrect = scored.some(s=>s.correct);
      if(!anyCorrect){
        // try category heuristics: if pdfHasCategory for known cats, mark options that map
        const cats = ['повышенная','особо','без'];
        const catPresent = {повышенная:pdfHasCategory('повышенная'), особо:pdfHasCategory('особо'), без:pdfHasCategory('без')};
        if(catPresent.повыщенная || catPresent.особо || catPresent.без){
          for(const s of scored){
            const cm = categoryMatch(s.text);
            if(cm){
              // mark correct if pdf contains that cat
              if(pdfHasCategory(cm)) s.correct = true;
            }
          }
        }
      }

      results.push({type:'choice', question, answers:scored});
    } else {
      // open question
      const best = findBestOpenAnswer(question, fragments);
      results.push({type:'open', question, answer: best.frag || 'Ответ не найден', confidence: Number((best.score||0).toFixed(3))});
    }
  });

  return res.json({results});
});

// helper used in open question
function findBestOpenAnswer(question, fragments){
  const q = norm(question);
  let best = {score:0, frag: ''};
  for(const frag of fragments){
    const f = norm(frag);
    const overlap = wordOverlap(q, f);
    const lev = levenshtein(q.slice(0,200), f.slice(0,200));
    const normLev = 1 - Math.min(1, lev / Math.max(1, Math.max(q.length, f.length)));
    const score = overlap*0.7 + normLev*0.3;
    if(score>best.score) best = {score, frag};
  }
  return best;
}

app.get('/ping', (_,res)=>res.send('pong'));

app.listen(port, ()=>console.log('Server up on', port));
