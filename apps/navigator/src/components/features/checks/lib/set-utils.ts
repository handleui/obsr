export const toggleInSet = (prev: Set<string>, value: string) => {
  const next = new Set(prev);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
};

export const soloInSet = (
  prev: Set<string>,
  value: string,
  allValues: string[]
): Set<string> => {
  if (prev.size === 1 && prev.has(value)) {
    return new Set(allValues);
  }
  return new Set([value]);
};

export const removeFromSet = (prev: Set<string>, ids: Iterable<string>) => {
  const toRemove = new Set(ids);
  if (toRemove.size === 0) {
    return prev;
  }

  const next = new Set<string>();
  for (const id of prev) {
    if (!toRemove.has(id)) {
      next.add(id);
    }
  }

  return next.size === prev.size ? prev : next;
};
