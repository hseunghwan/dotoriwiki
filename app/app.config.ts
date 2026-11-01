import type { ExpoConfig } from 'expo/config';

/**
 * The Android package id and launcher name. A build you install next to someone else's, or
 * publish, sets its own: DOTORIWIKI_APP_ID=com.example.notes DOTORIWIKI_APP_NAME=Notes.
 */
const id = process.env.DOTORIWIKI_APP_ID || 'dev.dotoriwiki.app';
const name = process.env.DOTORIWIKI_APP_NAME || undefined;

if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(id)) {
  throw new Error(`DOTORIWIKI_APP_ID "${id}" is not an Android package id, such as com.example.notes`);
}

const config: ExpoConfig = {
  name: name ?? 'Dotori',
  slug: 'dotoriwiki',
  version: '0.1.0',
  orientation: 'portrait',
  scheme: 'dotoriwiki',
  userInterfaceStyle: 'automatic',
  platforms: ['android'],
  // The default name has a Korean launcher label. A name you set is used as-is in every locale.
  locales: name ? undefined : { ko: { android: { app_name: '도토리' } } },
  android: {
    package: id,
    adaptiveIcon: {
      backgroundColor: '#7559dd',
      foregroundImage: './assets/images/android-icon-foreground.png',
      monochromeImage: './assets/images/android-icon-foreground.png',
    },
    softwareKeyboardLayoutMode: 'resize',
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    'expo-router',
    ['expo-splash-screen', { backgroundColor: '#ffffff', image: './assets/images/splash-icon.png', imageWidth: 160, dark: { backgroundColor: '#1e1e1e' } }],
    ['expo-build-properties', { android: { usesCleartextTraffic: true } }],
    './plugins/with-release-signing',
    'expo-sqlite',
    ['expo-camera', { recordAudioAndroid: false, microphonePermission: false, barcodeScannerEnabled: true }],
    'expo-location',
    ['expo-media-library', { savePhotosPermission: false, isAccessMediaLocationEnabled: true, granularPermissions: ['photo'] }],
    ['expo-image-picker', { photosPermission: false, microphonePermission: false }],
    'expo-secure-store',
    './plugins/with-capture-intents',
  ],
  experiments: { typedRoutes: true, reactCompiler: true },
};

export default config;
