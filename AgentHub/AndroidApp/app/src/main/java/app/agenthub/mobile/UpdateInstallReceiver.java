package app.agenthub.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.widget.Toast;

public final class UpdateInstallReceiver extends BroadcastReceiver {
    public static final String ACTION_INSTALL_STATUS = "app.agenthub.mobile.UPDATE_INSTALL_STATUS";

    @Override
    public void onReceive(Context context, Intent intent) {
        int status = intent.getIntExtra(
            PackageInstaller.EXTRA_STATUS,
            PackageInstaller.STATUS_FAILURE
        );
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirmation = Build.VERSION.SDK_INT >= 33
                ? intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class)
                : intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirmation != null) {
                confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(confirmation);
            }
            return;
        }
        if (status != PackageInstaller.STATUS_SUCCESS) {
            String detail = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
            Toast.makeText(
                context,
                detail == null || detail.isBlank() ? "Не удалось установить обновление" : detail,
                Toast.LENGTH_LONG
            ).show();
        }
    }
}
