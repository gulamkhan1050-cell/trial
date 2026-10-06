import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.swarmdesk.app',
  appName: 'Swarm Desk',
  webDir: 'dist',
  android: { backgroundColor: '#07090c' },
  plugins: {
    // Route fetch() through the native HTTP stack so exchange APIs work without CORS limits.
    CapacitorHttp: { enabled: true },
  },
};

export default config;
