// React state that survives page reloads via localStorage.
//
// Works like useState, but the initial value is loaded from localStorage and
// every change is written back. `load` turns the stored string (or null when
// nothing is stored) into the state value; `save` turns the state value into
// the string to store — returning null removes the key instead.

import { useState, useEffect } from 'react';

export function usePersistentState(key, load, save) {
  const [value, setValue] = useState(() => load(localStorage.getItem(key)));

  useEffect(() => {
    const stored = save(value);
    if (stored === null) localStorage.removeItem(key);
    else localStorage.setItem(key, stored);
  }, [key, value, save]);

  return [value, setValue];
}
