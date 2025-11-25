import pdfPlumber from 'pdfplumber';

/**
 * Извлекает текст из PDF файла
 * 
 * @param {string} pdfFilePath - Путь к PDF файлу
 * @returns {Promise<string>} - Текст из PDF
 */
export async function extractPdfText(pdfFilePath) {
    let text = "";

    try {
        const pdf = await pdfPlumber.open(pdfFilePath);
        for (const page of pdf.pages) {
            const pageText = await page.extract_text();
            text += pageText + "\n";
        }
    } catch (error) {
        throw new Error("Error reading PDF");
    }

    return text;
}
