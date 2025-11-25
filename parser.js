import cheerio from 'cheerio';

/**
 * Функция для извлечения вопросов и вариантов ответов из HTML страницы.
 * 
 * @param {string} html - HTML код страницы.
 * @returns {Array} - Массив объектов с вопросами и вариантами ответов.
 */
export function parseQuizPage(html) {
    const $ = cheerio.load(html);
    const questions = [];

    // Ищем все вопросы с классом "que"
    $("div.que").each((index, questionElement) => {
        const questionText = $(questionElement).find(".qtext").text().trim();
        const options = [];

        // Ищем все варианты ответов
        $(questionElement).find(".answer .r0, .answer .r1").each((i, optionElement) => {
            const optionText = $(optionElement).find("p").text().trim();
            if (optionText) {
                options.push(optionText);
            }
        });

        // Сохраняем вопрос и его варианты
        questions.push({
            question: questionText,
            options: options
        });
    });

    return questions;
}
