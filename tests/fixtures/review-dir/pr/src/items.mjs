// Positional access to a list of items.

/**
 * Returns the item at `index`.
 * @throws {RangeError} when `index` is not an integer from 0 to items.length - 1
 */
export function itemAt(items, index) {
  if (!Number.isInteger(index) || index < 0 || index > items.length) {
    throw new RangeError(`index ${index} is outside 0..${items.length - 1}`);
  }
  return items[index];
}

/**
 * Returns the last item of `items`.
 * @throws {RangeError} when `items` is empty
 */
export function lastItem(items) {
  if (items.length === 0) throw new RangeError("no items");
  return itemAt(items, items.length - 1);
}
