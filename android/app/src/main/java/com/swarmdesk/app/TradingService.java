package com.swarmdesk.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;

/**
 * Keeps the app alive while you use the phone for other things: a foreground service (the permanent
 * "Swarm Desk is trading" notification) plus a partial wake lock, so Android doesn't freeze the app's
 * process when it's in the background or the screen is off. The trading itself runs in the app's
 * WebView; this service only stops Android from putting it to sleep.
 */
public class TradingService extends Service {
    private static final String CHANNEL = "trading";
    private PowerManager.WakeLock lock;

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Trading", NotificationManager.IMPORTANCE_LOW));
        }
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
                .setContentTitle("Swarm Desk is trading")
                .setContentText("Running in the background — don't swipe the app away")
                .setSmallIcon(R.mipmap.ic_launcher)
                .setOngoing(true)
                .setContentIntent(tap)
                .build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(1, n);
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "swarmdesk:trading");
        lock.setReferenceCounted(false);
        lock.acquire();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (lock != null && lock.isHeld()) lock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
