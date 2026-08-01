package app.agenthub.mobile;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.List;

/** Read-only content provider for APK files already verified by MainActivity. */
public final class VerifiedUpdateFileProvider extends ContentProvider {
    private static final String MIME = "application/vnd.android.package-archive";
    private static final String[] DEFAULT_COLUMNS = {
        OpenableColumns.DISPLAY_NAME,
        OpenableColumns.SIZE,
    };

    public static Uri uriFor(Context context, File file) throws IOException {
        File allowedDirectory = new File(context.getCacheDir(), "updates").getCanonicalFile();
        File candidate = file.getCanonicalFile();
        if (
            !allowedDirectory.equals(candidate.getParentFile())
            || !candidate.getName().matches("AgentHub-Mobile-[1-9][0-9]*\\.apk")
            || !candidate.isFile()
        ) {
            throw new FileNotFoundException("Verified update APK was not found");
        }
        return new Uri.Builder()
            .scheme("content")
            .authority(BuildConfig.APPLICATION_ID + ".updates")
            .appendPath("update")
            .appendPath(candidate.getName())
            .build();
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public String getType(Uri uri) {
        resolve(uri);
        return MIME;
    }

    @Override
    public Cursor query(
        Uri uri,
        String[] projection,
        String selection,
        String[] selectionArgs,
        String sortOrder
    ) {
        File file = resolve(uri);
        String[] requested = projection == null ? DEFAULT_COLUMNS : projection;
        MatrixCursor cursor = new MatrixCursor(requested, 1);
        MatrixCursor.RowBuilder row = cursor.newRow();
        for (String column : requested) {
            if (OpenableColumns.DISPLAY_NAME.equals(column)) row.add(file.getName());
            else if (OpenableColumns.SIZE.equals(column)) row.add(file.length());
            else row.add(null);
        }
        return cursor;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("Update APK is read-only");
        return ParcelFileDescriptor.open(resolve(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("Update APK is read-only");
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("Update APK is read-only");
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("Update APK is read-only");
    }

    private File resolve(Uri uri) {
        Context context = getContext();
        if (context == null || !"content".equals(uri.getScheme())) {
            throw new IllegalArgumentException("Invalid update URI");
        }
        if (!(BuildConfig.APPLICATION_ID + ".updates").equals(uri.getAuthority())) {
            throw new IllegalArgumentException("Invalid update authority");
        }
        List<String> parts = uri.getPathSegments();
        if (
            parts.size() != 2
            || !"update".equals(parts.get(0))
            || !parts.get(1).matches("AgentHub-Mobile-[1-9][0-9]*\\.apk")
        ) {
            throw new IllegalArgumentException("Invalid update path");
        }
        try {
            File directory = new File(context.getCacheDir(), "updates").getCanonicalFile();
            File candidate = new File(directory, parts.get(1)).getCanonicalFile();
            if (!directory.equals(candidate.getParentFile()) || !candidate.isFile()) {
                throw new IllegalArgumentException("Update APK was not found");
            }
            return candidate;
        } catch (IOException error) {
            throw new IllegalArgumentException("Update APK path is invalid", error);
        }
    }
}
