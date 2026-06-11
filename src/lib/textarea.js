// Grows a textarea with its content (used by the composer and the settings
// "Instructions" field), up to the max-height set in CSS.

export const adjustTextareaHeight = (textarea) => {
  if (!textarea) return;
  textarea.style.height = 'auto';
  const scrollHeight = textarea.scrollHeight;
  // At least 48px tall, plus 2px to account for the border in border-box sizing.
  const targetHeight = Math.max(48, scrollHeight + 2);
  textarea.style.height = `${targetHeight}px`;

  // Only show a scrollbar once the textarea has hit its max height (200px).
  if (targetHeight >= 200) {
    textarea.style.overflowY = 'auto';
  } else {
    textarea.style.overflowY = 'hidden';
  }
};
