# Items: positional access

## Contract

`itemAt(items, index)` returns the item at `index` and throws a
`RangeError` when `index` is not an integer from 0 to `items.length - 1`.

`lastItem(items)` returns the last item and throws a `RangeError` on an
empty list. It is implemented as `itemAt(items, items.length - 1)`.

## Tests

The suite covers index 0, the last index, -1 and a fractional index.
