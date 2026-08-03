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
 */
export function ChartDataTable({ caption, headers, rows }: ChartDataTableProps) {
  return (
    <table className="sr-only">
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
  );
}
