// Используем require для всех зависимостей
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const cheerio = require('cheerio');

const app = express();
const port = 10000;

// Настройка multer для загрузки файлов
const upload = multer({ dest: 'uploads/' });

// Мидлвар для парсинга JSON и статических файлов
app.use(express.json());
app.use(express.static('src'));

// Обработчик для загрузки PDF
app.post('/upload-pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded');
  }

  try {
    // Чтение и загрузка PDF
    const pdfBytes = await fs.promises.readFile(req.file.path);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPages();
    const textContent = [];

    // Извлечение текста с каждой страницы PDF
    for (const page of pages) {
      const text = await page.getTextContent();
      textContent.push(text.items.map(item => item.str).join(' '));
    }

    // Возвращаем извлеченный текст
    res.json({ text: textContent.join('\n') });
  } catch (error) {
    console.error('Error processing the PDF file:', error);
    res.status(500).send('Error processing the PDF file');
  }
});

// Обработчик для обработки HTML кода теста
app.post('/process-quiz', (req, res) => {
  const { html } = req.body;
  if (!html) {
    return res.status(400).send('HTML code is required');
  }

  // Использование cheerio для парсинга HTML
  const $ = cheerio.load(html);
  const questions = [];

  // Пример обработки вопросов из HTML
  $('div.que').each((index, element) => {
    const questionText = $(element).find('.content').text().trim();
    const options = [];
    $(element).find('.answer').each((_, option) => {
      options.push($(option).text().trim());
    });
    questions.push({ question: questionText, options });
  });

  res.json(questions);
});

// Запуск сервера
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
