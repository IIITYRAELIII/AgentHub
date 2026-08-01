import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = import.meta.dirname;

test("Android updater accepts only a newer same-origin APK with the published SHA-256", async () => {
  const activity = await readFile(path.join(
    ROOT,
    "AndroidApp", "app", "src", "main", "java", "app", "agenthub", "mobile", "MainActivity.java",
  ), "utf8");
  assert.match(activity, /versionCode <= BuildConfig\.VERSION_CODE/u);
  assert.match(activity, /"\/api\/mobile\/update\.apk"\.equals\(downloadPath\)/u);
  assert.match(activity, /sameOrigin\(hub, download\)/u);
  assert.match(activity, /MessageDigest\.getInstance\("SHA-256"\)/u);
  assert.match(activity, /total != expectedBytes \|\| !expectedHash\.equals\(hex\(digest\.digest\(\)\)\)/u);
  assert.match(activity, /connection\.setInstanceFollowRedirects\(false\)/u);
  assert.match(activity, /VerifiedUpdateFileProvider\.uriFor/u);
  assert.match(activity, /Settings\.ACTION_MANAGE_UNKNOWN_APP_SOURCES/u);
  assert.match(activity, /new Intent\(Intent\.ACTION_VIEW\)/u);
});

test("Android update provider exposes only verified cache files and is not exported", async () => {
  const [manifest, provider, build, gradle] = await Promise.all([
    readFile(path.join(ROOT, "AndroidApp", "app", "src", "main", "AndroidManifest.xml"), "utf8"),
    readFile(path.join(
      ROOT,
      "AndroidApp", "app", "src", "main", "java", "app", "agenthub", "mobile",
      "VerifiedUpdateFileProvider.java",
    ), "utf8"),
    readFile(path.join(ROOT, "AndroidApp", "build.ps1"), "utf8"),
    readFile(path.join(ROOT, "AndroidApp", "app", "build.gradle"), "utf8"),
  ]);
  assert.match(manifest, /android:name="\.VerifiedUpdateFileProvider"/u);
  assert.match(manifest, /android:exported="false"/u);
  assert.match(manifest, /android:name="android\.permission\.REQUEST_INSTALL_PACKAGES"/u);
  assert.match(provider, /new File\(context\.getCacheDir\(\), "updates"\)/u);
  assert.match(provider, /AgentHub-Mobile-/u);
  assert.match(provider, /ParcelFileDescriptor\.MODE_READ_ONLY/u);
  assert.match(build, /assets\\mobile/u);
  assert.match(build, /Security\.Cryptography\.SHA256/u);
  assert.match(build, /AgentHub-Mobile\.apk/u);
  assert.match(build, /update\.json/u);
  assert.match(build, /ToUnixTimeSeconds\(\) \/ 60/u);
  assert.match(build, /previousVersionCode \+ 1/u);
  assert.match(build, /-PagentHubVersionCode=\$VersionCode/u);
  assert.match(build, /-PagentHubVersionName=\$VersionName/u);
  assert.match(gradle, /gradleProperty\("agentHubVersionCode"\)/u);
  assert.match(gradle, /gradleProperty\("agentHubVersionName"\)/u);
});
