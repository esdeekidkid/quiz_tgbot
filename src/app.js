// Подключаем необходимые библиотеки
const express = require('express');
const multer = require('multer');
const path = require('path');
const cheerio = require('cheerio');
const fs = require('fs');
const pdf = require('pdf-parse');

const app = express();
const port = 10000;

// Конфигурируем Multer для загрузки файлов
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Парсим HTML для извлечения вопросов и вариантов ответов
const parseHtmlQuiz = (html) => {
  const $ = cheerio.load(html);
  const questions = [];
  
  // Находим все вопросы и варианты ответов
  $('div.que').each((index, element) => {
    const question = $(element).find('.qtext').text().trim();
    const options = [];
    
    $(element).find('.answer').each((i, answerElement) => {
      options.push($(answerElement).text().trim());
    });
    
    questions.push({ question, options });
  });
  
  return questions;
};

// Обработка загрузки PDF
app.post('/upload-pdf', upload.single('pdf'), (req, res) => {
  if (!req.file) {
    return res.status(400).send({ error: 'No file uploaded' });
  }
  
  // Преобразуем PDF в текст
  pdf(req.file.buffer).then((data) => {
    res.json({ text: data.text });
  }).catch((err) => {
    res.status(500).send({ error: 'Failed to process PDF' });
  });
});

// Обработка HTML-кода с вопросами
app.post('/process-quiz', express.json(), (req, res) => {
  const { html } = req.body;
  const questions = parseHtmlQuiz(html);
  res.json(questions);
});

// Статический сервер для отдачи HTML страницы
app.use(express.static('public'));

// Запуск сервера
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
