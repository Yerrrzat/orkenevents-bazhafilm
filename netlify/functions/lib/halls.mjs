// Hall layouts (Arman Asia Park, halls 1-4 and the VIP hall). Must stay identical to the layout in index.html.
// rows: [seatCount, xOffset, y]; desc = seat numbers go right-to-left.
export const HALLS = [
  { rows: [[13, 1.5, 0], [19, 0, 1], [15, 4, 2.6], [15, 4, 4.4], [15, 4, 5.4], [15, 4, 6.4], [17, 2, 8]], desc: false },
  { rows: [[22, 0, 0], [22, 0, 1], [22, 0, 2], [22, 0, 3], [19, 3.25, 4.5], [20, 2.25, 5.5], [20, 2.25, 6.5], [20, 2.25, 7.5], [21, 0.75, 8.5]], desc: false },
  { rows: [[15, 0, 0], [16, 0, 1], [16, 0, 2], [12, 0, 3.3], [13, 0, 4.3], [13, 0, 5.3], [13, 0, 6.3], [14, 0, 7.3]], desc: true },
  { rows: [[9, 0, 0], [10, 0, 1], [7, 0, 2], [7, 0, 3], [6, 0, 4], [8, 0, 5]], desc: true },
  { rows: [[6, 0, 0], [6, 0, 1], [6, 0, 2]], desc: true, vip: true },   // VIP hall: 3 rows of 3 double seats
];
/** screening id -> { hall: number, seats: Map(seatId -> { r, n }) }. One screening per hall, all at the same time. */
export const SCREENINGS = {};
HALLS.forEach((h, i) => {
  const seats = new Map();
  h.rows.forEach(([cnt], ri) => { for (let k = 0; k < cnt; k++) { const n = h.desc ? cnt - k : k + 1; seats.set(`h${i + 1}r${ri + 1}s${n}`, { r: ri + 1, n }); } });
  SCREENINGS[`scr${i + 1}`] = { hall: h.vip ? 'VIP' : i + 1, vip: !!h.vip, seats };
});
