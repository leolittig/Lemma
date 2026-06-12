// Splits a reasoning model's output into its thinking phase and final answer.
// The server-side counterpart of this logic lives in server/thinking.py.
//
// The backend guarantees a well-formed block: it emits an opening tag when
// (and only when) the model is actually reasoning, so this is purely
// tag-driven. Two tag styles are supported:
//
//   Qwen style:    <think> ... </think>
//   Gemma 4 style: <|channel>thought ... <channel|>
//
// Cases:
//   close tag present        -> text before it is reasoning, after is answer.
//   open tag, no close yet   -> still thinking (streaming).
//   no tags                  -> plain answer (non-reasoning model, or off).

export const parseThinking = (text) => {
  // Qwen style.
  const closeQ = text.indexOf('</think>');
  if (closeQ !== -1) {
    let thinking = text.slice(0, closeQ);
    const ot = thinking.indexOf('<think>');
    if (ot !== -1) thinking = thinking.slice(ot + '<think>'.length);
    return { thinking, answer: text.slice(closeQ + '</think>'.length), done: true };
  }
  const openQ = text.indexOf('<think>');
  if (openQ !== -1) {
    return { thinking: text.slice(openQ + '<think>'.length), answer: '', done: false };
  }

  // Gemma 4 style.
  const closeG = text.indexOf('<channel|>');
  if (closeG !== -1) {
    let thinking = text.slice(0, closeG);
    const ot = thinking.indexOf('<|channel>thought');
    if (ot !== -1) thinking = thinking.slice(ot + '<|channel>thought'.length);
    return { thinking, answer: text.slice(closeG + '<channel|>'.length), done: true };
  }
  const openG = text.indexOf('<|channel>thought');
  if (openG !== -1) {
    return { thinking: text.slice(openG + '<|channel>thought'.length), answer: '', done: false };
  }

  return { thinking: null, answer: text, done: true };
};
