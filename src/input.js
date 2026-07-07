// Keyboard input mapped to a normalized control state.
const keys = new Set();

window.addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

export function readControls() {
  return {
    throttle: (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0),
    // Positive steer = counterclockwise heading in this world basis, which
    // reads as turning LEFT on screen — so the left keys map to positive.
    steer: (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) - (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0),
    handbrake: keys.has('Space'),
    reset: keys.has('KeyR'),
  };
}
