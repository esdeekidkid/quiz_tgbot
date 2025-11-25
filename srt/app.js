import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { PDFDocument } from 'pdf-lib';
import cheerio from 'cheerio';
import axios from 'axios';

// Настроим сервер Express
const app = express();
const port = process.env.PORT || 10000;

// Настройка для загрузки файлов
const upload = multer({ dest: 'uploads/' });

// Для парсинга HTML страниц
function parseQuizHtml(html) {
  const $ = cheerio.load(html);
  const questions = [];
  $('div.que').each((i, elem) => {
    const questionText = $(elem).find('.qtext').text().trim();
    const options = [];
    $(elem).find('.answer').each((i, optionElem) => {
      options.push($(optionElem).text().trim());
    });
    questions.push({ questionText, options });
  });
  return questions;
}

// Эндпоинт для загрузки PDF
app.post('/upload-pdf', upload.single('pdf'), async (req, res) => {
  try {
    const pdfPath = path.join(__dirname, 'uploads', req.file.filename);
    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const text = await pdfDoc.getTextContent();  // Извлечение текста из PDF

    // Для примера просто отдаем текст
    res.json({ text });
  } catch (error) {
    res.status(500).send('Error processing PDF');
  }
});

// Эндпоинт для обработки HTML
app.post('/process-quiz', express.json(), (req, res) => {
  const { html } = req.body;
  const questions = parseQuizHtml(html);
  res.json(questions);
});

// Запуск сервера
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
