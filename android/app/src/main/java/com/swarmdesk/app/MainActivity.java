package com.swarmdesk.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Android 13+: the trading notification needs permission to show.
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1);
        }
        Intent service = new Intent(this, TradingService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(service);
        else startService(service);
        askToIgnoreBatteryOptimization();
    }

    /** Battery optimisation would still freeze the app in the background: ask once to be exempt. */
    @SuppressLint("BatteryLife")
    private void askToIgnoreBatteryOptimization() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm == null || pm.isIgnoringBatteryOptimizations(getPackageName())) return;
        try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
        } catch (Exception ignored) {
            // Some phones don't offer the dialog; the user can set Battery → Unrestricted by hand.
        }
    }

    // Leaving the app (a call, WhatsApp, screen off) must not pause the trading engine in the WebView.
    @Override
    public void onPause() {
        super.onPause();
        keepRunning();
    }

    @Override
    public void onStop() {
        super.onStop();
        keepRunning();
    }

    private void keepRunning() {
        if (bridge == null) return;
        WebView web = bridge.getWebView();
        if (web == null) return;
        web.onResume();
        web.resumeTimers();
    }

    @Override
    public void onDestroy() {
        stopService(new Intent(this, TradingService.class));
        super.onDestroy();
    }
}
