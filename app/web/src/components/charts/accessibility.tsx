export interface ChartDataTableProps {
  caption: string;
  headers: string[];
  rows: Array<{ cells: Array<string | number> }>;
}

/**
 * Screen-reader-visible data table paired with every Canvas chart. ECharts
 * renders to Canvas and is not accessible to assistive technology; this
 * table is the authoritative representation (WCAG 1.1.1, 1.3.1). The canvas
 * itself is never given keyboard semantics.
 *
 * The visually-hidden class sits on a WRAPPER, not on the table. A table box
 * ignores a height smaller than its rows, so `sr-only` on the `<table>` left
 * a 30-row data table at full height, absolutely positioned under its chart:
 * invisible, but it stretched the page by ~90px past its last panel.
 */
export function ChartDataTable({ caption, headers, rows }: ChartDataTableProps) {
  return (
    <div className="sr-only">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {headers.map((header) => (
              <th scope="col" key={header}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.cells.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
