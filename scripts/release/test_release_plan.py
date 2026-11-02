import unittest

import release_plan as rp


def releases(*tags, drafts=()):
    listed = [{"tagName": tag, "isDraft": False, "isPrerelease": "beta" in tag} for tag in tags]
    listed += [{"tagName": tag, "isDraft": True, "isPrerelease": "beta" in tag} for tag in drafts]
    return listed


class Ordering(unittest.TestCase):
    def test_first_beta_then_beta_then_stable_then_next(self):
        history = []
        for tag, aliases in [
            ("v0.26.0-beta.1", {"stable": False, "latest": False, "beta": True}),
            ("v0.26.0-beta.2", {"stable": False, "latest": False, "beta": True}),
            ("v0.26.0", {"stable": True, "latest": True, "beta": True}),
            ("v0.26.1-beta.1", {"stable": False, "latest": False, "beta": True}),
            ("v0.26.1", {"stable": True, "latest": True, "beta": True}),
        ]:
            result = rp.plan(tag, releases(*history))
            self.assertEqual(result["state"], "new", tag)
            self.assertEqual(result["aliases"], aliases, tag)
            history.append(tag)

    def test_a_beta_cannot_follow_its_own_stable(self):
        with self.assertRaisesRegex(rp.PlanError, "must be newer"):
            rp.plan("v0.26.0-beta.3", releases("v0.26.0-beta.2", "v0.26.0"))

    def test_a_stable_must_be_newer_than_the_newest_stable(self):
        with self.assertRaisesRegex(rp.PlanError, "stable alias backwards"):
            rp.plan("v0.26.0", releases("v0.26.0-beta.1", "v0.26.1"))
        with self.assertRaises(ValueError):
            rp.plan("v0.25.9", releases("v0.26.0"))  # not even a coordinated version

    def test_a_beta_must_be_newer_than_every_published_release(self):
        with self.assertRaisesRegex(rp.PlanError, "beta alias backwards"):
            rp.plan("v0.26.1-beta.1", releases("v0.27.0-beta.1"))

    def test_a_stable_hotfix_beside_a_newer_beta_moves_only_the_stable_aliases(self):
        result = rp.plan("v0.26.1", releases("v0.26.0", "v0.27.0-beta.1"))
        self.assertEqual(result["aliases"], {"stable": True, "latest": True, "beta": False})

    def test_drafts_do_not_count_as_published(self):
        result = rp.plan("v0.26.0", releases("v0.25.0", drafts=["v0.26.0", "v0.27.0"]))
        self.assertEqual(result["state"], "draft")
        self.assertEqual(result["aliases"]["stable"], True)

    def test_other_release_trains_are_ignored(self):
        history = releases("player-v0.25.0", "player-linux-v0.17.0", "edge-v0.2.1-preview.1", "wpe-2.54.0-abc-x86_64", "server-v0.1.0")
        result = rp.plan("v0.26.0-beta.1", history)
        self.assertEqual(result["state"], "new")
        self.assertEqual(result["previousTag"], "")


class Resume(unittest.TestCase):
    def test_a_published_release_resumes_without_an_ordering_check(self):
        result = rp.plan("v0.26.0", releases("v0.26.0", "v0.26.1"))
        self.assertEqual(result["state"], "published")

    def test_a_resumed_release_never_moves_an_alias_backwards(self):
        result = rp.plan("v0.26.0", releases("v0.26.0", "v0.26.1"))
        self.assertEqual(result["aliases"], {"stable": False, "latest": False, "beta": False})

    def test_a_resumed_newest_release_still_owns_its_aliases(self):
        result = rp.plan("v0.26.1", releases("v0.26.0", "v0.26.1"))
        self.assertEqual(result["aliases"], {"stable": True, "latest": True, "beta": True})

    def test_a_published_beta_does_not_own_stable(self):
        result = rp.plan("v0.27.0-beta.1", releases("v0.26.0", "v0.27.0-beta.1"))
        self.assertEqual(result["aliases"], {"stable": False, "latest": False, "beta": True})


class NotesBaseline(unittest.TestCase):
    def test_stable_compares_with_the_previous_stable(self):
        result = rp.plan("v0.27.0", releases("v0.26.0", "v0.27.0-beta.1", "v0.27.0-beta.2"))
        self.assertEqual(result["previousTag"], "v0.26.0")

    def test_beta_compares_with_the_release_just_before(self):
        result = rp.plan("v0.27.0-beta.3", releases("v0.26.0", "v0.27.0-beta.1", "v0.27.0-beta.2"))
        self.assertEqual(result["previousTag"], "v0.27.0-beta.2")

    def test_the_first_release_has_no_baseline(self):
        self.assertEqual(rp.plan("v0.26.0-beta.1", [])["previousTag"], "")


class InvalidTags(unittest.TestCase):
    def test_non_coordinated_tags_are_refused(self):
        for tag in ("player-v0.26.0", "v0.25.0", "v0.26.0-rc.1", "0.26.0", ""):
            with self.assertRaises(ValueError, msg=tag):
                rp.plan(tag, [])


if __name__ == "__main__":
    unittest.main()
