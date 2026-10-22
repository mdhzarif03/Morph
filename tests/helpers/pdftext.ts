import { promises as fs } from 'node:fs';
import { PDFiumLibrary } from '@hyzyla/pdfium';

/** Text of every page of a PDF, read with the same bundled PDFium the app uses. */
export async function pdfPageTexts(file: string): Promise<string[]> {
  const library = await PDFiumLibrary.init();
  const bytes = await fs.readFile(file);
  const doc = await library.loadDocument(new Uint8Array(bytes));
  try {
    const texts: string[] = [];
    for (const page of doc.pages()) {
      texts.push(page.getText());
      page.close();
    }
    return texts;
  } finally {
    doc.destroy();
  }
}
