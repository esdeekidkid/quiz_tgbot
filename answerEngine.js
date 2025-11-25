import stringSimilarity from "string-similarity";

/**
 * Функция для поиска лучшего ответа из лекции.
 * 
 * @param {string} question - Текст вопроса.
 * @param {Array} options - Варианты ответа.
 * @param {string} lectureText - Текст лекции.
 * @returns {string} - Лучший вариант ответа.
 */
export function getBestAnswer(question, options, lectureText) {
    const lines = lectureText.split("\n").map(line => line.trim()).filter(Boolean);
    let bestAnswer = "";

    // Для каждого варианта ищем наилучшее совпадение с лекцией
    let bestScore = -1;
    options.forEach(option => {
        const { bestMatch } = stringSimilarity.findBestMatch(option, lines);
        if (bestMatch.rating > bestScore) {
            bestScore = bestMatch.rating;
            bestAnswer = option;
        }
    });

    return bestAnswer || "Не найдено подходящего ответа";
}
