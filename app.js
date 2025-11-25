import express from 'express';
import multer from 'multer';
import fs from 'fs';
import { PDFDocument } from 'pdf-lib';
import * as cheerio from 'cheerio'; // исправление импорта
import path from 'path';

// Настройка загрузки файлов с помощью multer
const upload = multer({ dest: 'uploads/' });

const app = express();
const port = process.env.PORT || 3000;

let lectureText = ''; // Для хранения текста из PDF

// Функция для извлечения текста из PDF
async function extractPdfText(pdfFilePath) {
    const existingPdfBytes = fs.readFileSync(pdfFilePath);
    const pdfDoc = await PDFDocument.load(existingPdfBytes);
    let text = '';

    const pages = pdfDoc.getPages();
    pages.forEach(page => {
        const pageText = page.getTextContent(); // Извлекаем текст
        text += pageText;
    });

    return text;
}

// Функция для извлечения вопросов и вариантов ответов из HTML
function extractQuestionsFromHtml(html) {
    const $ = cheerio.load(html);
    const questions = [];

    $('.que').each((index, element) => {
        const questionText = $(element).find('.qtext').text().trim();
        const options = [];

        $(element).find('.answer input').each((i, el) => {
            options.push($(el).parent().text().trim());
        });

        questions.push({ question: questionText, options: options });
    });

    return questions;
}

// Маршрут для загрузки PDF
app.post('/upload-pdf', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }

    const pdfFilePath = path.join(__dirname, req.file.path);
    lectureText = await extractPdfText(pdfFilePath);

    res.send('PDF uploaded and text extracted!');
});

// Маршрут для обработки HTML теста
app.post('/submit-test', express.text(), (req, res) => {
    if (!lectureText) {
        return res.status(400).send('No lecture data found. Please upload a PDF first.');
    }

    const html = req.body; // Получаем HTML-код из тела запроса
    const questions = extractQuestionsFromHtml(html);

    // Возвращаем извлеченные вопросы и ответы
    res.json({ questions });
});

// Запуск сервера
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
