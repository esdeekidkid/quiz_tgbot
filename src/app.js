// Используем require вместо import
const express = require('express');
const multer = require('multer');
const cheerio = require('cheerio');
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const axios = require('axios');
const path = require('path');

const app = express();
const port = 10000;

// Настройка multer для загрузки файлов
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Папка для хранения загруженных файлов
const uploadFolder = 'uploads';

// Убедитесь, что папка существует
if (!fs.existsSync(uploadFolder)) {
  fs.mkdirSync(uploadFolder);
}

// Путь для обработки POST-запроса с PDF-файлом
app.post('/upload-pdf', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded.');
  }

  const pdfBuffer = req.file.buffer;
  (async () => {
    try {
      // Обработка PDF с использованием pdf-lib
      const pdfDoc = await PDFDocument.load(pdfBuffer);
      const pages = pdfDoc.getPages();
      const firstPage = pages[0];
      const text = firstPage.getTextContent();

      console.log('PDF text:', text); // Логируем текст из PDF

      res.status(200).send('PDF uploaded and processed.');
    } catch (error) {
      console.error('Error processing PDF:', error);
      res.status(500).send('Error processing PDF.');
    }
  })();
});

// Путь для обработки POST-запроса с HTML-кодом страницы теста
app.post('/process-html', express.text(), (req, res) => {
  const html = req.body;
  const $ = cheerio.load(html);
  
  // Пример парсинга HTML с использованием cheerio
  const questions = [];
  $('div.que').each((index, element) => {
    const questionText = $(element).find('.qtext').text().trim();
    const options = [];
    $(element).find('.answer').each((i, ans) => {
      options.push($(ans).text().trim());
    });
    questions.push({ question: questionText, options });
  });

  console.log('Parsed questions:', questions); // Логируем вопросы

  res.status(200).json(questions);
});

// Запуск сервера
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
