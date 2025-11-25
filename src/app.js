const express = require('express');  // Подключаем express
const multer = require('multer');    // Подключаем multer для обработки загрузки файлов
const path = require('path');        // Для работы с путями

// Создаем экземпляр приложения Express
const app = express();
const port = process.env.PORT || 10000;

// Настройка хранения файлов для multer (например, загрузка PDF)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/'); // Папка для сохранения загруженных файлов
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname)); // Генерация уникального имени для каждого файла
  }
});

// Мидлвар для загрузки файлов
const upload = multer({ storage });

// Статическая папка для загрузки файлов (если нужно)
app.use(express.static('public'));

// Обработчик для корневого пути "/"
app.get('/', (req, res) => {
  res.send('Привет, это веб-приложение для обработки тестов!');
});

// Обработчик для загрузки PDF файла
app.post('/upload-pdf', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).send('Не выбран файл.');
  }

  // Выводим информацию о загруженном файле
  console.log(`Файл загружен: ${req.file.filename}`);
  res.send(`Файл "${req.file.filename}" успешно загружен!`);
});

// Дополнительные маршруты для обработки тестов могут быть добавлены здесь

// Запуск приложения на порту
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
