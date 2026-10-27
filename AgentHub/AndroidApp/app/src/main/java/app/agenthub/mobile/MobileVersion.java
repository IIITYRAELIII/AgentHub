package app.agenthub.mobile;

import java.math.BigInteger;
import java.time.LocalDate;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Public precedence guard, independent of Android's strictly increasing code. */
final class MobileVersion {
    private static final String N = "(0|[1-9][0-9]*)";
    private static final Pattern SEMVER = Pattern.compile("^" + N + "\\." + N + "\\." + N
        + "(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$");
    private static Matcher parse(String value) {
        Matcher m = SEMVER.matcher(value);
        if (!m.matches()) return null;
        if (m.group(4) != null) for (String id : m.group(4).split("\\.")) {
            if (id.matches("[0-9]+") && id.length() > 1 && id.startsWith("0")) return null;
        }
        return m;
    }
    private static boolean calendar(String value) {
        Matcher m = Pattern.compile("^(\\d{4})\\.(\\d{1,2})\\.(\\d{1,2})(?:\\.(\\d{4}))?$").matcher(value);
        if (!m.matches()) return false;
        try {
            if (Integer.parseInt(m.group(1)) < 2000) return false;
            LocalDate.of(Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3)));
            return m.group(4) == null || (Integer.parseInt(m.group(4).substring(0, 2)) < 24
                && Integer.parseInt(m.group(4).substring(2)) < 60);
        } catch (RuntimeException error) { return false; }
    }
    static boolean allowsUpgrade(String current, int code, String next, int nextCode) {
        if (nextCode <= code || nextCode > 2100000000 || nextCode < 1) return false;
        Matcher b = parse(next);
        if (b == null || calendar(next)) return false;
        if (calendar(current)) return new BigInteger(b.group(1)).compareTo(BigInteger.valueOf(2)) >= 0;
        Matcher a = parse(current);
        if (a == null) return false;
        for (int i = 1; i <= 3; i++) {
            int c = new BigInteger(b.group(i)).compareTo(new BigInteger(a.group(i)));
            if (c != 0) return c > 0;
        }
        String ap = a.group(4), bp = b.group(4);
        if (ap == null || bp == null) return bp == null;
        String[] aa = ap.split("\\."), bb = bp.split("\\.");
        for (int i = 0; i < Math.max(aa.length, bb.length); i++) {
            if (i >= aa.length || i >= bb.length) return i >= aa.length;
            String x = aa[i], y = bb[i];
            if (x.equals(y)) continue;
            boolean xn = x.matches("[0-9]+"), yn = y.matches("[0-9]+");
            if (xn != yn) return xn;
            return xn ? new BigInteger(y).compareTo(new BigInteger(x)) > 0 : y.compareTo(x) > 0;
        }
        return true;
    }
}
