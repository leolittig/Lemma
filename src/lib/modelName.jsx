// Pretty-prints a model repo id for the top bar.
//
// "mlx-community/gemma-4-12B-it-8bit" renders as "Gemma 4 12B it 8bit": the
// org prefix is dropped, each '-' separated word is capitalised, and once a
// word ends with the letter 'b' (case insensitive — i.e. the parameter count
// like "12B") that word and every word after it are dimmed and left in their
// original casing.

export const renderModelName = (name) => {
  if (!name) return null;
  const baseName = name.split('/').pop() || name;
  const parts = baseName.split('-');
  let dim = false;
  return parts.map((word, i) => {
    if (!dim && /b$/i.test(word)) dim = true;
    const text = dim ? word : word.charAt(0).toUpperCase() + word.slice(1);
    return (
      <span key={i} className={dim ? 'model-name-dim' : undefined}>
        {text}{i < parts.length - 1 ? ' ' : ''}
      </span>
    );
  });
};
