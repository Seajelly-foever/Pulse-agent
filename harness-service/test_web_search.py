from unittest import TestCase
from unittest.mock import patch

import app


class WebSearchTest(TestCase):
    def test_bing_provider_is_called_without_cross_engine_fallback(self):
        evidence = [{"title": "Result", "url": "https://example.com/result", "content": "Evidence", "engine": "bing"}]
        with patch.object(app, "search_bing", return_value=evidence) as search:
            result = app.web_search(app.WebSearchRequest(query="DeepSeek Harness", count=3), None)

        self.assertEqual(result["provider"], "bing")
        self.assertEqual(result["backend"], "bing")
        self.assertEqual(result["results"][0]["url"], "https://example.com/result")
        search.assert_called_once_with("DeepSeek Harness", 3, "cn-zh", 15)
