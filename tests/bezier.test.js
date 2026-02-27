import { describe, it, expect } from 'vitest';

describe('evaluateQuadraticBezierY', () => {
    it('returns ~0 for inputX=0', () => {
        expect(evaluateQuadraticBezierY(0, 0.5, 0.5)).toBeCloseTo(0, 2);
    });

    it('returns ~1 for inputX=1', () => {
        expect(evaluateQuadraticBezierY(1, 0.5, 0.5)).toBeCloseTo(1, 2);
    });

    it('approximates linear for cx=0.5, cy=0.5', () => {
        const y = evaluateQuadraticBezierY(0.5, 0.5, 0.5);
        expect(y).toBeCloseTo(0.5, 1);
    });

    it('produces concave curve when cy < cx', () => {
        // Control point below diagonal → output < input for mid values
        const y = evaluateQuadraticBezierY(0.5, 0.8, 0.2);
        expect(y).toBeLessThan(0.5);
    });

    it('produces convex curve when cy > cx', () => {
        // Control point above diagonal → output > input for mid values
        const y = evaluateQuadraticBezierY(0.5, 0.2, 0.8);
        expect(y).toBeGreaterThan(0.5);
    });

    it('clamps output to [0, 1]', () => {
        // Even with extreme control points
        for (let x = 0; x <= 1; x += 0.1) {
            const y = evaluateQuadraticBezierY(x, 0.01, 0.99);
            expect(y).toBeGreaterThanOrEqual(0);
            expect(y).toBeLessThanOrEqual(1);
        }
    });

    it('handles edge case cx=0 (degenerate)', () => {
        const y = evaluateQuadraticBezierY(0.5, 0, 0.5);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(1);
    });

    it('handles edge case cx=1 (degenerate)', () => {
        const y = evaluateQuadraticBezierY(0.5, 1, 0.5);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(1);
    });

    it('is monotonically increasing for reasonable control points', () => {
        let prev = 0;
        for (let x = 0; x <= 1; x += 0.05) {
            const y = evaluateQuadraticBezierY(x, 0.3, 0.7);
            expect(y).toBeGreaterThanOrEqual(prev - 0.001); // small tolerance
            prev = y;
        }
    });
});
