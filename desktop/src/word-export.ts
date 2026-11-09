import {
  Document,
  Paragraph,
  Packer,
  TextRun,
  HeadingLevel,
  ShadingType,
} from "docx";
import { rowHeading, tokenSeparator, type DisplayRow } from "./presentation";
import type { TranscriptView } from "./transcript";

export async function transcriptDocx(
  title: string,
  rows: DisplayRow[],
  view: TranscriptView,
): Promise<Uint8Array> {
  const document = new Document({
    creator: "Transcript Studio",
    title,
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 22, color: "000000" },
          paragraph: { spacing: { after: 160, line: 300 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 },
          },
        },
        children: [
          new Paragraph({
            text: title,
            heading: HeadingLevel.TITLE,
            spacing: { after: 320 },
          }),
          ...rows.flatMap((row) => {
            const heading = rowHeading(row, view);
            const body = row.tokens.flatMap((token, i) => {
              const runs: TextRun[] = [];
              const space = tokenSeparator(row.tokens[i - 1], token);
              if (space) runs.push(new TextRun(space));
              runs.push(
                new TextRun({
                  text: token.text,
                  ...(token.uncertainty
                    ? {
                        shading: {
                          type: ShadingType.CLEAR,
                          fill:
                            token.uncertainty === "unknown"
                              ? "E5E7EB"
                              : "FFF0B3",
                        },
                      }
                    : {}),
                  ...(view.reviewed && token.reviewed
                    ? { color: "276749" }
                    : {}),
                }),
              );
              if (view.reviewed && token.reviewed && token.kind === "word")
                runs.push(
                  new TextRun({
                    text: "✓",
                    superScript: true,
                    color: "276749",
                  }),
                );
              return runs;
            });
            return [
              ...(heading
                ? [
                    new Paragraph({
                      children: [new TextRun({ text: heading, bold: true })],
                      keepNext: true,
                      spacing: { before: 180, after: 70 },
                    }),
                  ]
                : []),
              new Paragraph({ children: body, widowControl: true }),
            ];
          }),
        ],
      },
    ],
  });
  return new Uint8Array(await (await Packer.toBlob(document)).arrayBuffer());
}
