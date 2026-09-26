/* Navigation policy (threat review §9), the Android WebsiteNavigationPolicy rules. */
#include "policy.h"
#include "rw-protocol.h"

static GPtrArray *
hosts (const char *first, ...)
{
  GPtrArray *array = g_ptr_array_new_with_free_func (g_free);
  va_list args;
  va_start (args, first);
  for (const char *host = first; host != NULL; host = va_arg (args, const char *))
    g_ptr_array_add (array, g_strdup (host));
  va_end (args);
  return array;
}

#define ALLOW(target, configured, list) g_assert_cmpint (tc_policy_main_frame (target, configured, list), ==, TC_NAV_ALLOW)
#define BLOCK(target, configured, list) g_assert_cmpint (tc_policy_main_frame (target, configured, list), ==, TC_NAV_BLOCK)

int
main (void)
{
  g_autoptr (GPtrArray) list = hosts ("signage.example.org", "cdn.example.org", "10.0.0.5", NULL);
  const char *https = "https://signage.example.org/";
  const char *http = "http://10.0.0.5/";
  ALLOW ("https://signage.example.org/board?q=1#x", https, list);
  ALLOW ("https://SIGNAGE.example.org./a", https, list);
  ALLOW ("https://cdn.example.org:443/", https, list);
  BLOCK ("https://evil.example.org/", https, list);
  BLOCK ("https://signage.example.org.evil.test/", https, list);
  BLOCK ("https://sub.signage.example.org/", https, list);
  BLOCK ("https://signage.example.org:8443/", https, list);
  BLOCK ("https://user@signage.example.org/", https, list);
  BLOCK ("http://signage.example.org/", https, list); /* no downgrade */
  ALLOW ("http://10.0.0.5/menu", http, list);
  ALLOW ("https://10.0.0.5/menu", http, list);
  BLOCK ("http://10.0.0.5:8080/", http, list);
  BLOCK ("file:///var/lib/tilecast-edge/state.db", https, list);
  BLOCK ("tilecast://runtime/index.html", https, list);
  BLOCK ("tcmedia://cap/" "0000000000000000000000000000000000000000000000000000000000000000", https, list);
  BLOCK ("tcweb://cap/" "0000000000000000000000000000000000000000000000000000000000000000", https, list);
  BLOCK ("javascript:alert(1)", https, list);
  BLOCK ("data:text/html,hi", https, list);
  BLOCK ("about:blank", https, list);
  BLOCK ("ftp://signage.example.org/", https, list);
  BLOCK ("mailto:someone@example.org", https, list);
  BLOCK ("intent://x#Intent;end", https, list);
  BLOCK (NULL, https, list);
  BLOCK ("https://signage.example.org/", https, NULL);

  g_assert_cmpint (tc_policy_any_frame ("https://maps.example.net/embed"), ==, TC_NAV_ALLOW);
  g_assert_cmpint (tc_policy_any_frame ("about:blank"), ==, TC_NAV_ALLOW);
  g_assert_cmpint (tc_policy_any_frame ("about:srcdoc"), ==, TC_NAV_ALLOW);
  g_assert_cmpint (tc_policy_any_frame ("data:text/html,x"), ==, TC_NAV_ALLOW);
  g_assert_cmpint (tc_policy_any_frame ("file:///etc/passwd"), ==, TC_NAV_BLOCK);
  g_assert_cmpint (tc_policy_any_frame ("tilecast://runtime/index.html"), ==, TC_NAV_BLOCK);
  g_assert_cmpint (tc_policy_any_frame ("tcmedia://cap/x"), ==, TC_NAV_BLOCK);
  g_assert_cmpint (tc_policy_any_frame ("about:config"), ==, TC_NAV_BLOCK);
  g_assert_cmpint (tc_policy_any_frame ("https://a:b@maps.example.net/"), ==, TC_NAV_BLOCK);

  g_autofree char *logged = tc_policy_log_host ("https://Signage.example.org/secret?token=abc");
  g_assert_cmpstr (logged, ==, "signage.example.org");
  g_print ("rw-policy: ok\n");
  return 0;
}
