// Page math for the merchant Negotiations list. Kept free of imports so it
// can be tested on its own.

export const NEGOTIATIONS_PAGE_SIZE = 50;

export type PageWindow = {
  page: number;
  totalPages: number;
  // How many rows to skip in the query to reach this page.
  skip: number;
  hasPrevious: boolean;
  hasNext: boolean;
};

// requestedPage comes straight from the URL (?page=2), so it can be anything:
// missing, zero, negative, a fraction, text, or a page number far past the
// end. Anything that isn't a whole number of 1 or more becomes page 1, and a
// page past the end becomes the last page, so the list is never empty just
// because the address was edited or the data shrank.
export function getPageWindow(
  total: number,
  requestedPage: unknown,
  pageSize: number,
): PageWindow {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const asNumber =
    typeof requestedPage === "number" ? requestedPage : Number(requestedPage);
  const wanted = Number.isInteger(asNumber) && asNumber >= 1 ? asNumber : 1;
  const page = Math.min(wanted, totalPages);
  return {
    page,
    totalPages,
    skip: (page - 1) * pageSize,
    hasPrevious: page > 1,
    hasNext: page < totalPages,
  };
}
