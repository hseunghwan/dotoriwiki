// The suites assert Korean copy, so they run as a Korean phone whatever this machine's locale is.
// text.test.ts loads the table again under other tags.
jest.mock('./src/text/device', () => ({ deviceTag: jest.fn(() => 'ko-KR') }));
