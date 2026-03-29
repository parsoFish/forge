---
name: canvas-game
category: frontend
description: HTML5 Canvas game development patterns — game loop, rendering, input, state management, and Vite/Vitest tooling.
---

## When to Use This Skill

- When working on trafficGame or any HTML5 Canvas-based game
- When implementing game loops, rendering pipelines, or input handling
- When writing tests for canvas-based components with Vitest
- When configuring Vite for game asset bundling

## Game Loop Pattern

```typescript
// Fixed timestep with variable rendering
const TICK_RATE = 1000 / 60; // 60 updates/sec
let lastTime = 0;
let accumulator = 0;

function gameLoop(timestamp: number): void {
  const delta = timestamp - lastTime;
  lastTime = timestamp;
  accumulator += delta;

  // Fixed-step updates (deterministic)
  while (accumulator >= TICK_RATE) {
    update(TICK_RATE / 1000);
    accumulator -= TICK_RATE;
  }

  // Variable-rate rendering with interpolation
  const alpha = accumulator / TICK_RATE;
  render(alpha);

  requestAnimationFrame(gameLoop);
}
```

## Canvas Rendering Best Practices

- **Layer canvases**: static background + dynamic foreground (avoid redrawing everything)
- **Batch draws**: group similar draw calls (same fill style, same operation)
- **Off-screen canvas**: pre-render complex shapes, blit to main canvas
- **Transform state**: always `save()`/`restore()` around transform blocks
- **Pixel-perfect**: use `Math.round()` for positions to avoid sub-pixel blur
- **Device pixel ratio**: scale canvas for Retina/HiDPI displays

```typescript
function setupHiDPI(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
}
```

## Input Handling

- **Event delegation**: single listener on canvas, not per-entity
- **Input buffer**: collect inputs per frame, process during update
- **Keyboard state map**: track pressed keys, check in update loop

```typescript
const keys = new Set<string>();
canvas.addEventListener('keydown', (e) => keys.add(e.key));
canvas.addEventListener('keyup', (e) => keys.delete(e.key));

// In update:
if (keys.has('ArrowRight')) player.moveRight(dt);
```

## State Management

- **Immutable game state**: each tick produces a new state object
- **Entity-Component-System (ECS)**: for complex games with many entity types
- **State machine**: for game phases (menu → playing → paused → game-over)

## Testing with Vitest

```typescript
// Mock canvas context for unit tests
const mockCtx = {
  fillRect: vi.fn(),
  clearRect: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  // ... other methods as needed
} as unknown as CanvasRenderingContext2D;

// Test game logic without canvas
describe('GameState', () => {
  it('advances simulation by one tick', () => {
    const state = createInitialState();
    const next = tick(state, 1/60);
    expect(next.frame).toBe(state.frame + 1);
  });
});
```

## Vite Configuration for Games

```typescript
// vite.config.ts
export default defineConfig({
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        // Single chunk for game — avoid loading latency
        manualChunks: undefined,
      },
    },
  },
  // Asset handling for sprites/audio
  assetsInclude: ['**/*.png', '**/*.wav', '**/*.ogg'],
});
```

## Playwright E2E for Canvas Games

```typescript
// Can't inspect canvas DOM — use screenshot comparison
test('game renders initial state', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('canvas');
  await expect(page).toHaveScreenshot('initial-state.png', {
    maxDiffPixelRatio: 0.01,
  });
});

// Or test via exposed game API
test('pressing S starts simulation', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('s');
  const isRunning = await page.evaluate(() => window.__gameState?.running);
  expect(isRunning).toBe(true);
});
```
