import { addTap } from '../taps';

function tapAt(times: number[]): boolean[] {
  let taps: number[] = [];
  return times.map((now) => {
    const next = addTap(taps, now);
    taps = next.taps;
    return next.fired;
  });
}

test('three taps within a second fire on the third', () => {
  expect(tapAt([0, 300, 900])).toEqual([false, false, true]);
});

test('two taps do nothing', () => {
  expect(tapAt([0, 200])).toEqual([false, false]);
});

test('three taps spread over more than a second do not fire', () => {
  expect(tapAt([0, 600, 1100])).toEqual([false, false, false]);
});

test('after firing, the count starts over', () => {
  expect(tapAt([0, 100, 200, 300, 400])).toEqual([false, false, true, false, false]);
});
