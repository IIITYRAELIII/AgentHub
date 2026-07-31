package app.agenthub.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
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

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile String accessToken = "";
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
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
        if (webView != null) {
            webView.removeJavascriptInterface("AgentHubAndroid");
            webView.destroy();
        }
        worker.shutdownNow();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
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
                runOnUiThread(() -> showHub(serverUrl));
            } catch (Exception error) {
                accessToken = "";
                runOnUiThread(() -> showPairing(serverUrl, readableError(error)));
            }
        };
        if (alreadyOnWorker) operation.run(); else worker.execute(operation);
    }

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    private void showHub(String serverUrl) {
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(7, 17, 22));
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setAllowFileAccess(false);
        webView.getSettings().setAllowContentAccess(false);
        webView.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        if (android.os.Build.VERSION.SDK_INT >= 26) webView.getSettings().setSafeBrowsingEnabled(true);
        webView.addJavascriptInterface(new DeviceAuthBridge(), "AgentHubAndroid");
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

    private boolean sameOrigin(Uri left, Uri right) {
        return "https".equalsIgnoreCase(right.getScheme())
            && left.getHost() != null
            && left.getHost().equalsIgnoreCase(right.getHost())
            && effectivePort(left) == effectivePort(right);
    }

    private int effectivePort(Uri uri) {
        return uri.getPort() == -1 ? 443 : uri.getPort();
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
            if (!"https".equalsIgnoreCase(url.getProtocol()) || url.getHost().isBlank()) return "";
            return normalized;
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
    }
}
