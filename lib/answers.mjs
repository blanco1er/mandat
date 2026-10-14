// Ready answers: the model ends a question with a line ">> A | B | C", shown as buttons under it, never as text.
// Some models send several ">>" lines (one per day): none of them is ever shown, the first one becomes the buttons.
export function readyAnswers(content) {
  let text = String(content || '').trim(), choices = [];
  const rows = [...text.matchAll(/^\s*>>\s*([^\n]+)$/gm)];
  if (rows.length) {
    choices = rows[0][1].split('|').map((x) => x.trim().replace(/^[*"«]+|[*"»]+$/g, '')).filter(Boolean).slice(0, 5);
    text = text.replace(/^\s*>>[^\n]*\n?/gm, '').trim();
  }
  return { text, choices };
}
