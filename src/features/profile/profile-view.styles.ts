import * as stylex from '@stylexjs/stylex';

/**
 * Local styles for the account summary. The panels, tiles, table and buttons come from `ui`;
 * everything here is specific to the history panel's own controls.
 */
export const styles = stylex.create({
  /** Filter and paging controls above the table. */
  toolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    gap: 10,
    marginBottom: 12,
  },

  filterBox: {
    flex: '1 1 220px',
    minWidth: 0,
  },

  /** A page-size picker is a control, not a text field: it keeps its natural width. */
  pageSize: {
    width: 'auto',
  },

  /** A column header is a sort control, so it keeps the header's own type. */
  sortButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: 0,
    border: 0,
    background: 'none',
    font: 'inherit',
    color: 'inherit',
    textTransform: 'inherit',
    letterSpacing: 'inherit',
    cursor: 'pointer',
  },

  sortMark: {
    fontSize: '.72em',
    lineHeight: 1,
  },
});
