export const analysisZoom = 10;
export const analysisScale = 2**analysisZoom;

export function analysisCells(ax, ay, bx, by) {
  const cells = [];
  const firstX = Math.floor(Math.min(ax,bx)*analysisScale);
  const lastX = Math.floor(Math.max(ax,bx)*analysisScale);
  const firstY = Math.max(0,Math.floor(Math.min(ay,by)*analysisScale));
  const lastY = Math.min(analysisScale-1,Math.floor(Math.max(ay,by)*analysisScale));
  for (let y=firstY; y<=lastY; y++) for (let x=firstX; x<=lastX; x++) {
    cells.push([(x+analysisScale)%analysisScale,y]);
  }
  return cells;
}
