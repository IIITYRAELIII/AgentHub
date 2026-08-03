package app.agenthub.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.graphics.Color;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.view.ActionMode;
import android.view.Gravity;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.cert.Certificate;
import java.security.spec.ECGenParameterSpec;
import java.util.Base64;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.SSLException;

public final class MainActivity extends Activity {
    private static final String PREFS = "agent-hub-mobile";
    private static final String PREF_URL = "server-url";
    private static final String PREF_DEVICE_ID = "device-id";
    private static final String KEY_ALIAS = "agent-hub-device-v1";
    private static final int MAX_RESPONSE_BYTES = 1024 * 1024;
    private static final long MAX_UPDATE_BYTES = 100L * 1024L * 1024L;
    private static final long UPDATE_CHECK_INTERVAL_MS = 5L * 60L * 1000L;
    private static final int REQUEST_UNKNOWN_SOURCES = 1201;
    private static final int REQUEST_IMAGE_CHOOSER = 1202;
    private static final int MENU_ANNOTATE_SELECTION = 0x41485542;
    private static final String APK_TYPE = "application/vnd.android.package-archive";

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile String accessToken = "";
    private volatile boolean updateCheckInFlight = false;
    private volatile long lastUpdateCheckAt = 0L;
    private volatile String activeServerUrl = "";
    private File pendingUpdateFile;
    private WebView webView;
    private ValueCallback<Uri[]> pendingFileChooser;
    private final OnBackInvokedCallback backCallback = this::handleBackNavigation;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                backCallback
            );
        }
        String configuredUrl = getPreferences().getString(PREF_URL, normalizeUrl(BuildConfig.AGENT_HUB_URL));
        String deviceId = getPreferences().getString(PREF_DEVICE_ID, "");
        if (!configuredUrl.isBlank() && !deviceId.isBlank() && keyExists()) {
            showBusy("Подключение к Agent Hub…");
            authenticate(configuredUrl, deviceId, false);
        } else {
            showPairing(configuredUrl, "");
        }
    }

    @Override
    protected void onDestroy() {
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
        }
        if (webView != null) {
            webView.removeJavascriptInterface("AgentHubAndroid");
            webView.destroy();
        }
        if (pendingFileChooser != null) {
            pendingFileChooser.onReceiveValue(null);
            pendingFileChooser = null;
        }
        worker.shutdownNow();
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_IMAGE_CHOOSER) {
            ValueCallback<Uri[]> callback = pendingFileChooser;
            pendingFileChooser = null;
            if (callback != null) callback.onReceiveValue(selectedFiles(resultCode, data));
            return;
        }
        if (requestCode != REQUEST_UNKNOWN_SOURCES || pendingUpdateFile == null) return;
        File update = pendingUpdateFile;
        pendingUpdateFile = null;
        if (android.os.Build.VERSION.SDK_INT < 26 || getPackageManager().canRequestPackageInstalls()) {
            installVerifiedUpdate(update);
        } else {
            Toast.makeText(this, "Установка обновления не разрешена.", Toast.LENGTH_LONG).show();
        }
    }

    @Override
    public void onBackPressed() {
        handleBackNavigation();
    }

    private void handleBackNavigation() {
        if (webView != null) {
            webView.evaluateJavascript(
                "Boolean(window.AgentHub && window.AgentHub.navigateBack && window.AgentHub.navigateBack())",
                handled -> {
                    if ("true".equalsIgnoreCase(String.valueOf(handled))) return;
                    runOnUiThread(this::finishBackNavigation);
                }
            );
            return;
        }
        finishBackNavigation();
    }

    private void finishBackNavigation() {
        // Agent Hub owns navigation inside its single WebView. At the task
        // list root a system edge-back is a no-op instead of closing the app
        // or navigating to an authentication/bootstrap document.
        if (webView != null) return;
        finish();
    }

    private android.content.SharedPreferences getPreferences() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private void showBusy(String text) {
        LinearLayout root = screen();
        ProgressBar progress = new ProgressBar(this);
        TextView label = label(text, 17);
        label.setGravity(Gravity.CENTER);
        root.setGravity(Gravity.CENTER);
        root.addView(progress);
        root.addView(label, margins(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, 0, 24, 0, 0));
        setContentView(root);
    }

    private void showPairing(String currentUrl, String error) {
        LinearLayout root = screen();
        root.setPadding(dp(28), dp(40), dp(28), dp(28));
        TextView title = label("Agent Hub", 28);
        title.setTextColor(Color.rgb(141, 221, 203));
        root.addView(title);
        TextView hint = label("Добавление доверенного устройства", 17);
        root.addView(hint, margins(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, 0, 8, 0, 24));

        EditText url = input("HTTPS-адрес Agent Hub", currentUrl);
        EditText code = input("Одноразовый код сопряжения", "");
        root.addView(url);
        root.addView(code, margins(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, 0, 12, 0, 0));

        TextView errorView = label(error, 14);
        errorView.setTextColor(Color.rgb(255, 139, 139));
        errorView.setVisibility(error.isBlank() ? View.GONE : View.VISIBLE);
        root.addView(errorView, margins(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, 0, 14, 0, 0));

        Button pair = new Button(this);
        pair.setText("Добавить телефон");
        pair.setAllCaps(false);
        pair.setOnClickListener(view -> {
            String serverUrl = normalizeUrl(url.getText().toString());
            String pairingCode = code.getText().toString().trim();
            if (serverUrl.isBlank() || pairingCode.isBlank()) {
                errorView.setText("Укажите HTTPS-адрес и код сопряжения.");
                errorView.setVisibility(View.VISIBLE);
                return;
            }
            showBusy("Добавление устройства…");
            pair(serverUrl, pairingCode);
        });
        root.addView(pair, margins(ViewGroup.LayoutParams.MATCH_PARENT, dp(52), 0, 22, 0, 0));
        setContentView(root);
    }

    private void pair(String serverUrl, String pairingCode) {
        worker.execute(() -> {
            try {
                ensureKey();
                JSONObject request = new JSONObject()
                    .put("code", pairingCode)
                    .put("name", android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL)
                    .put("platform", "Android " + android.os.Build.VERSION.RELEASE)
                    .put("publicKey", publicKey());
                JSONObject response = post(serverUrl + "/api/device/pair", request);
                String deviceId = response.getJSONObject("device").getString("id");
                getPreferences().edit()
                    .putString(PREF_URL, serverUrl)
                    .putString(PREF_DEVICE_ID, deviceId)
                    .apply();
                authenticate(serverUrl, deviceId, true);
            } catch (Exception error) {
                runOnUiThread(() -> showPairing(serverUrl, readableError(error)));
            }
        });
    }

    private void authenticate(String serverUrl, String deviceId, boolean alreadyOnWorker) {
        Runnable operation = () -> {
            try {
                JSONObject challenge = post(serverUrl + "/api/device/challenge", new JSONObject().put("deviceId", deviceId));
                String challengeId = challenge.getString("challengeId");
                String challengeValue = challenge.getString("challenge");
                String message = String.join("\n", "agent-hub-device-session-v1", deviceId, challengeId, challengeValue);
                JSONObject session = post(serverUrl + "/api/device/session", new JSONObject()
                    .put("deviceId", deviceId)
                    .put("challengeId", challengeId)
                    .put("signature", sign(message)));
                accessToken = session.getString("token");
                runOnUiThread(() -> {
                    showHub(serverUrl);
                    checkForUpdate(serverUrl, true);
                });
            } catch (Exception error) {
                accessToken = "";
                runOnUiThread(() -> showPairing(serverUrl, readableError(error)));
            }
        };
        if (alreadyOnWorker) operation.run(); else worker.execute(operation);
    }

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    private void showHub(String serverUrl) {
        activeServerUrl = serverUrl;
        webView = new AgentHubWebView(this);
        webView.setBackgroundColor(Color.rgb(7, 17, 22));
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setAllowFileAccess(false);
        // File-system paths stay disabled. Content access is required only for
        // image URIs explicitly selected through Android's document picker.
        webView.getSettings().setAllowContentAccess(true);
        webView.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        if (android.os.Build.VERSION.SDK_INT >= 26) webView.getSettings().setSafeBrowsingEnabled(true);
        webView.addJavascriptInterface(new DeviceAuthBridge(), "AgentHubAndroid");
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                WebView view,
                ValueCallback<Uri[]> callback,
                FileChooserParams params
            ) {
                if (pendingFileChooser != null) pendingFileChooser.onReceiveValue(null);
                pendingFileChooser = callback;
                Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("image/*")
                    .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(picker, REQUEST_IMAGE_CHOOSER);
                    return true;
                } catch (ActivityNotFoundException error) {
                    pendingFileChooser = null;
                    callback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "Выбор изображений недоступен.", Toast.LENGTH_LONG).show();
                    return false;
                }
            }
        });
        Uri trustedOrigin = Uri.parse(serverUrl);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri target = request.getUrl();
                if (sameOrigin(trustedOrigin, target)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, target));
                } catch (ActivityNotFoundException ignored) {
                    // No external browser is available.
                }
                return true;
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (sameOrigin(trustedOrigin, request.getUrl())) return null;
                return new WebResourceResponse(
                    "text/plain",
                    "UTF-8",
                    403,
                    "Blocked",
                    java.util.Map.of("Cache-Control", "no-store"),
                    new java.io.ByteArrayInputStream(new byte[0])
                );
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) {
                handler.cancel();
                showPairing(serverUrl, "Ошибка проверки HTTPS-сертификата.");
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showPairing(serverUrl, "Agent Hub недоступен.");
            }
        });
        setContentView(webView);
        webView.loadUrl(serverUrl);
    }

    private Uri[] selectedFiles(int resultCode, Intent data) {
        if (resultCode != Activity.RESULT_OK || data == null) return null;
        ClipData clip = data.getClipData();
        if (clip != null) {
            Uri[] values = new Uri[clip.getItemCount()];
            for (int index = 0; index < clip.getItemCount(); index++) {
                values[index] = clip.getItemAt(index).getUri();
            }
            return values;
        }
        Uri single = data.getData();
        return single == null ? null : new Uri[] {single};
    }

    private final class AgentHubWebView extends WebView {
        AgentHubWebView(Context context) {
            super(context);
        }

        private ActionMode.Callback withAnnotationAction(ActionMode.Callback original) {
            return new ActionMode.Callback2() {
                private void ensureAnnotationAction(Menu menu) {
                    if (menu.findItem(MENU_ANNOTATE_SELECTION) != null) return;
                    MenuItem annotation = menu.add(
                        Menu.NONE,
                        MENU_ANNOTATE_SELECTION,
                        Menu.CATEGORY_SECONDARY,
                        "Цитировать"
                    );
                    annotation.setShowAsAction(
                        MenuItem.SHOW_AS_ACTION_ALWAYS | MenuItem.SHOW_AS_ACTION_WITH_TEXT
                    );
                }

                @Override
                public boolean onCreateActionMode(ActionMode mode, Menu menu) {
                    boolean created = original.onCreateActionMode(mode, menu);
                    if (created) ensureAnnotationAction(menu);
                    return created;
                }

                @Override
                public boolean onPrepareActionMode(ActionMode mode, Menu menu) {
                    boolean prepared = original.onPrepareActionMode(mode, menu);
                    ensureAnnotationAction(menu);
                    return prepared;
                }

                @Override
                public boolean onActionItemClicked(ActionMode mode, MenuItem item) {
                    if (item.getItemId() == MENU_ANNOTATE_SELECTION) {
                        evaluateJavascript(
                            "Boolean(window.AgentHub && window.AgentHub.addSelectedAnnotation && window.AgentHub.addSelectedAnnotation())",
                            null
                        );
                        mode.finish();
                        return true;
                    }
                    return original.onActionItemClicked(mode, item);
                }

                @Override
                public void onDestroyActionMode(ActionMode mode) {
                    original.onDestroyActionMode(mode);
                }

                @Override
                public void onGetContentRect(ActionMode mode, View view, Rect outRect) {
                    if (original instanceof ActionMode.Callback2) {
                        ((ActionMode.Callback2) original).onGetContentRect(mode, view, outRect);
                    } else {
                        outRect.set(0, 0, view.getWidth(), view.getHeight());
                    }
                }
            };
        }

        @Override
        public ActionMode startActionMode(ActionMode.Callback callback) {
            return super.startActionMode(withAnnotationAction(callback));
        }

        @Override
        public ActionMode startActionMode(ActionMode.Callback callback, int type) {
            return super.startActionMode(withAnnotationAction(callback), type);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (!activeServerUrl.isBlank() && !accessToken.isBlank()) checkForUpdate(activeServerUrl, false);
    }

    private boolean sameOrigin(Uri left, Uri right) {
        return "https".equalsIgnoreCase(right.getScheme())
            && left.getHost() != null
            && left.getHost().equalsIgnoreCase(right.getHost())
            && effectivePort(left) == effectivePort(right);
    }

    private int effectivePort(Uri uri) {
        return uri.getPort() == -1 ? 443 : uri.getPort();
    }

    private synchronized void checkForUpdate(String serverUrl, boolean force) {
        long now = System.currentTimeMillis();
        if (updateCheckInFlight || serverUrl.isBlank() || accessToken.isBlank()) return;
        if (!force && now - lastUpdateCheckAt < UPDATE_CHECK_INTERVAL_MS) return;
        updateCheckInFlight = true;
        lastUpdateCheckAt = now;
        worker.execute(() -> {
            try {
                JSONObject manifest = getJson(serverUrl + "/api/mobile/update");
                int versionCode = manifest.getInt("versionCode");
                if (versionCode <= BuildConfig.VERSION_CODE) return;
                String versionName = manifest.getString("versionName").trim();
                String expectedHash = manifest.getString("sha256").trim().toLowerCase();
                long expectedBytes = manifest.getLong("bytes");
                String downloadPath = manifest.getString("downloadUrl").trim();
                if (
                    versionName.isEmpty()
                    || !expectedHash.matches("[a-f0-9]{64}")
                    || expectedBytes < 1 || expectedBytes > MAX_UPDATE_BYTES
                    || !"/api/mobile/update.apk".equals(downloadPath)
                ) {
                    throw new IllegalStateException("Некорректный manifest обновления.");
                }
                URL hub = new URL(serverUrl);
                URL download = new URL(hub, downloadPath);
                if (!sameOrigin(hub, download)) throw new SSLException("Источник обновления не доверен.");
                File apk = downloadVerifiedUpdate(download, versionCode, expectedBytes, expectedHash);
                if (isFinishing() || isDestroyed()) return;
                runOnUiThread(() -> handleDownloadedUpdate(versionName, apk));
            } catch (Exception ignored) {
                // Обновление не должно мешать подключению к уже работающему Hub.
            } finally {
                updateCheckInFlight = false;
            }
        });
    }

    private File downloadVerifiedUpdate(
        URL download,
        int versionCode,
        long expectedBytes,
        String expectedHash
    ) throws Exception {
        File directory = new File(getCacheDir(), "updates");
        if (!directory.isDirectory() && !directory.mkdirs()) {
            throw new IllegalStateException("Не удалось подготовить каталог обновления.");
        }
        File temporary = new File(directory, "AgentHub-Mobile-" + versionCode + ".apk.tmp");
        File target = new File(directory, "AgentHub-Mobile-" + versionCode + ".apk");
        HttpURLConnection connection = trustedGet(download);
        try {
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new IllegalStateException("HTTP " + status);
            long advertisedBytes = connection.getContentLengthLong();
            if (advertisedBytes != -1 && advertisedBytes != expectedBytes) {
                throw new IllegalStateException("Размер APK не совпадает с manifest.");
            }
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long total = 0;
            try (
                InputStream input = connection.getInputStream();
                FileOutputStream output = new FileOutputStream(temporary, false)
            ) {
                byte[] buffer = new byte[32 * 1024];
                for (int count; (count = input.read(buffer)) != -1;) {
                    total += count;
                    if (total > expectedBytes || total > MAX_UPDATE_BYTES) {
                        throw new IllegalStateException("APK больше заявленного размера.");
                    }
                    digest.update(buffer, 0, count);
                    output.write(buffer, 0, count);
                }
                output.getFD().sync();
            }
            if (total != expectedBytes || !expectedHash.equals(hex(digest.digest()))) {
                throw new IllegalStateException("SHA-256 APK не совпадает с manifest.");
            }
            if (target.exists() && !target.delete()) {
                throw new IllegalStateException("Не удалось заменить старое обновление.");
            }
            if (!temporary.renameTo(target)) {
                throw new IllegalStateException("Не удалось сохранить обновление.");
            }
            return target;
        } finally {
            connection.disconnect();
            if (temporary.exists() && !temporary.delete()) temporary.deleteOnExit();
        }
    }

    private void handleDownloadedUpdate(String versionName, File update) {
        if (Build.VERSION.SDK_INT >= 31 && getPackageManager().canRequestPackageInstalls()) {
            Toast.makeText(this, "Обновление " + versionName + " загружено", Toast.LENGTH_SHORT).show();
            installVerifiedUpdate(update);
            return;
        }
        showUpdateReady(versionName, update);
    }

    private void showUpdateReady(String versionName, File update) {
        new AlertDialog.Builder(this)
            .setTitle("Обновление Agent Hub")
            .setMessage("Версия " + versionName + " загружена и проверена.")
            .setNegativeButton("Позже", null)
            .setPositiveButton("Установить", (dialog, which) -> requestUpdateInstallation(update))
            .show();
    }

    private void requestUpdateInstallation(File update) {
        if (android.os.Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            pendingUpdateFile = update;
            try {
                startActivityForResult(
                    new Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + BuildConfig.APPLICATION_ID)
                    ),
                    REQUEST_UNKNOWN_SOURCES
                );
            } catch (ActivityNotFoundException error) {
                pendingUpdateFile = null;
                Toast.makeText(this, "Откройте разрешение установки приложений вручную.", Toast.LENGTH_LONG).show();
            }
            return;
        }
        installVerifiedUpdate(update);
    }

    private void installVerifiedUpdate(File update) {
        if (Build.VERSION.SDK_INT >= 31) {
            worker.execute(() -> {
                try {
                    installWithPackageInstaller(update);
                } catch (Exception error) {
                    runOnUiThread(() -> launchPackageInstaller(update));
                }
            });
            return;
        }
        launchPackageInstaller(update);
    }

    private void installWithPackageInstaller(File update) throws Exception {
        PackageInstaller installer = getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(
            PackageInstaller.SessionParams.MODE_FULL_INSTALL
        );
        params.setAppPackageName(BuildConfig.APPLICATION_ID);
        params.setSize(update.length());
        params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        int sessionId = installer.createSession(params);
        try (PackageInstaller.Session session = installer.openSession(sessionId)) {
            try (
                FileInputStream input = new FileInputStream(update);
                OutputStream output = session.openWrite("base.apk", 0, update.length())
            ) {
                byte[] buffer = new byte[32 * 1024];
                for (int count; (count = input.read(buffer)) != -1;) output.write(buffer, 0, count);
                session.fsync(output);
            }
            Intent status = new Intent(this, UpdateInstallReceiver.class)
                .setAction(UpdateInstallReceiver.ACTION_INSTALL_STATUS);
            PendingIntent pending = PendingIntent.getBroadcast(
                this,
                sessionId,
                status,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE
            );
            session.commit(pending.getIntentSender());
        }
    }

    private void launchPackageInstaller(File update) {
        Uri uri;
        try {
            uri = VerifiedUpdateFileProvider.uriFor(this, update);
        } catch (Exception error) {
            Toast.makeText(this, "Файл обновления недоступен.", Toast.LENGTH_LONG).show();
            return;
        }
        Intent install = new Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, APK_TYPE)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivity(install);
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, "Системный установщик APK недоступен.", Toast.LENGTH_LONG).show();
        }
    }

    private JSONObject getJson(String endpoint) throws Exception {
        URL url = new URL(endpoint);
        HttpURLConnection connection = trustedGet(url);
        try {
            int status = connection.getResponseCode();
            InputStream input = status >= 200 && status < 300
                ? connection.getInputStream()
                : connection.getErrorStream();
            JSONObject result = new JSONObject(new String(readBounded(input), StandardCharsets.UTF_8));
            if (status < 200 || status >= 300) {
                throw new IllegalStateException(result.optString("error", "HTTP " + status));
            }
            return result;
        } finally {
            connection.disconnect();
        }
    }

    private HttpURLConnection trustedGet(URL url) throws Exception {
        if (!"https".equalsIgnoreCase(url.getProtocol())) throw new SSLException("Разрешён только HTTPS.");
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(60_000);
        connection.setRequestProperty("Authorization", "device " + accessToken);
        connection.setRequestProperty("Accept-Encoding", "identity");
        return connection;
    }

    private boolean sameOrigin(URL left, URL right) {
        return "https".equalsIgnoreCase(right.getProtocol())
            && left.getHost().equalsIgnoreCase(right.getHost())
            && effectivePort(left) == effectivePort(right);
    }

    private int effectivePort(URL url) {
        return url.getPort() == -1 ? url.getDefaultPort() : url.getPort();
    }

    private String hex(byte[] value) {
        StringBuilder result = new StringBuilder(value.length * 2);
        for (byte item : value) result.append(String.format(java.util.Locale.ROOT, "%02x", item & 0xff));
        return result.toString();
    }

    private void ensureKey() throws Exception {
        if (keyExists()) return;
        KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY
        )
            .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(false)
            .build();
        generator.initialize(spec);
        generator.generateKeyPair();
    }

    private boolean keyExists() {
        try {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            return store.containsAlias(KEY_ALIAS);
        } catch (Exception ignored) {
            return false;
        }
    }

    private String publicKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        Certificate certificate = store.getCertificate(KEY_ALIAS);
        if (certificate == null) throw new IllegalStateException("Ключ устройства не найден.");
        return base64Url(certificate.getPublicKey().getEncoded());
    }

    private String sign(String value) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        Signature signature = Signature.getInstance("SHA256withECDSA");
        signature.initSign((java.security.PrivateKey) store.getKey(KEY_ALIAS, null));
        signature.update(value.getBytes(StandardCharsets.UTF_8));
        return base64Url(derToP1363(signature.sign()));
    }

    private byte[] derToP1363(byte[] der) {
        int[] cursor = {0};
        if (readByte(der, cursor) != 0x30) throw new IllegalArgumentException("Invalid ECDSA signature");
        readLength(der, cursor);
        byte[] result = new byte[64];
        readInteger(der, cursor, result, 0);
        readInteger(der, cursor, result, 32);
        return result;
    }

    private void readInteger(byte[] der, int[] cursor, byte[] result, int offset) {
        if (readByte(der, cursor) != 0x02) throw new IllegalArgumentException("Invalid ECDSA integer");
        int length = readLength(der, cursor);
        while (length > 32 && der[cursor[0]] == 0) {
            cursor[0]++;
            length--;
        }
        if (length > 32 || cursor[0] + length > der.length) throw new IllegalArgumentException("Invalid ECDSA integer");
        System.arraycopy(der, cursor[0], result, offset + 32 - length, length);
        cursor[0] += length;
    }

    private int readLength(byte[] der, int[] cursor) {
        int value = readByte(der, cursor);
        if ((value & 0x80) == 0) return value;
        int count = value & 0x7f;
        if (count < 1 || count > 2) throw new IllegalArgumentException("Invalid DER length");
        int length = 0;
        for (int index = 0; index < count; index++) length = (length << 8) | readByte(der, cursor);
        return length;
    }

    private int readByte(byte[] bytes, int[] cursor) {
        if (cursor[0] >= bytes.length) throw new IllegalArgumentException("Invalid DER value");
        return bytes[cursor[0]++] & 0xff;
    }

    private JSONObject post(String endpoint, JSONObject payload) throws Exception {
        URL url = new URL(endpoint);
        if (!"https".equalsIgnoreCase(url.getProtocol())) throw new SSLException("Разрешён только HTTPS.");
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(30_000);
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(body.length);
        try (OutputStream output = connection.getOutputStream()) {
            output.write(body);
        }
        int status = connection.getResponseCode();
        InputStream input = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
        byte[] response = readBounded(input);
        JSONObject result = new JSONObject(new String(response, StandardCharsets.UTF_8));
        if (status < 200 || status >= 300) throw new IllegalStateException(result.optString("error", "HTTP " + status));
        return result;
    }

    private byte[] readBounded(InputStream input) throws Exception {
        if (input == null) return "{}".getBytes(StandardCharsets.UTF_8);
        try (input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int total = 0;
            for (int count; (count = input.read(buffer)) != -1;) {
                total += count;
                if (total > MAX_RESPONSE_BYTES) throw new IllegalStateException("Слишком большой ответ сервера.");
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }

    private String readableError(Exception error) {
        String message = error.getMessage();
        return message == null || message.isBlank() ? "Не удалось подключить устройство." : message;
    }

    private String base64Url(byte[] value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
    }

    private String normalizeUrl(String value) {
        String normalized = value == null ? "" : value.trim();
        while (normalized.endsWith("/")) normalized = normalized.substring(0, normalized.length() - 1);
        try {
            URL url = new URL(normalized);
            if (
                !"https".equalsIgnoreCase(url.getProtocol())
                || url.getHost().isBlank()
                || url.getUserInfo() != null
                || url.getQuery() != null
                || url.getRef() != null
                || !(url.getPath().isEmpty() || "/".equals(url.getPath()))
            ) return "";
            return url.getProtocol() + "://" + url.getAuthority();
        } catch (Exception ignored) {
            return "";
        }
    }

    private LinearLayout screen() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(7, 17, 22));
        return root;
    }

    private TextView label(String text, int sizeSp) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextColor(Color.rgb(225, 235, 237));
        view.setTextSize(sizeSp);
        return view;
    }

    private EditText input(String hint, String text) {
        EditText input = new EditText(this);
        input.setHint(hint);
        input.setHintTextColor(Color.rgb(115, 137, 141));
        input.setTextColor(Color.WHITE);
        input.setText(text);
        input.setSingleLine(true);
        return input;
    }

    private LinearLayout.LayoutParams margins(int width, int height, int left, int top, int right, int bottom) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(width, height);
        params.setMargins(dp(left), dp(top), dp(right), dp(bottom));
        return params;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    public final class DeviceAuthBridge {
        @JavascriptInterface
        public String getAccessToken() {
            return accessToken;
        }

        @JavascriptInterface
        public String getDeviceId() {
            return getPreferences().getString(PREF_DEVICE_ID, "");
        }

        @JavascriptInterface
        public void onHubRestarted(String releaseId) {
            runOnUiThread(() -> checkForUpdate(activeServerUrl, true));
        }
    }
}
