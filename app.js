import express from 'express';
import { parseQuizPage } from './parser.js';
import { getBestAnswer } from './answerEngine.js';
import { extractPdfText } from './utils/pdfReader.js';

const app = express();
app.use(express.json());

const LECTURES = {};

// Загружаем PDF файл и извлекаем текст
app.post('/upload-pdf', async (req, res) => {
    const { pdfFile } = req.body;
    const chatId = req.body.chatId;

    if (!pdfFile) {
        return res.status(400).send("No PDF file provided");
    }

    try {
        const pdfText = await extractPdfText(pdfFile);
        LECTURES[chatId] = pdfText;
        res.send("Lecture PDF uploaded successfully!");
    } catch (error) {
        res.status(500).send("Error extracting PDF text");
    }
});

// Получаем HTML код теста и находим ответы
app.post('/process-test', (req, res) => {
    const { html, chatId } = req.body;
    
    if (!html || !LECTURES[chatId]) {
        return res.status(400).send("No test HTML or lecture found");
    }

    // Парсим HTML страницы с тестом
    const questions = parseQuizPage(html);
    const answers = questions.map(q => {
        if (q.options.length > 0) {
            return {
                question: q.question,
                answer: getBestAnswer(q.question, q.options, LECTURES[chatId])
            };
        } else {
            return {
                question: q.question,
                answer: getBestAnswer(q.question, [], LECTURES[chatId])  // для открытых вопросов
            };
        }
    });

    res.json(answers);
});

app.listen(3000, () => {
    console.log('Server running on port 3000');
});
