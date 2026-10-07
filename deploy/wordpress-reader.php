<?php
/** Private WP-CLI reader: only published content and taxonomies, no mutations. */
if (!defined('WP_CLI') || !WP_CLI || count($args) !== 2) {
    exit(1);
}
$route = $args[0];
if (!preg_match('#^/wp/v2/(posts|pages|categories|tags)(/[1-9][0-9]*)?$#D', $route)) {
    WP_CLI::error('Unsupported read route.');
}
$params = json_decode($args[1], true);
if (!is_array($params)) {
    WP_CLI::error('Invalid query.');
}
$user = get_user_by('login', 'manacost-mcp');
if (!$user || !in_array('manacost_mcp_reader', $user->roles, true)) {
    WP_CLI::error('Integration account unavailable.');
}
wp_set_current_user($user->ID);
$request = new WP_REST_Request('GET', $route);
foreach ($params as $key => $value) {
    $request->set_param($key, $value);
}
if (preg_match('#^/wp/v2/(posts|pages)(?:/([1-9][0-9]*))?$#D', $route, $matches)) {
    $request->set_param('context', 'edit');
    $request->set_param('status', 'publish');
    // Raw fields avoid executing frontend shortcodes and expensive renderers.
    $request->set_param('_fields', 'id,link,date_gmt,modified_gmt,title.raw,content.raw,content.protected,password,categories,tags,slug,status,author,featured_media');
    if (isset($matches[2])) {
        $post = get_post((int) $matches[2]);
        if (!$post || $post->post_status !== 'publish' || $post->post_password !== '') {
            echo wp_json_encode(['status' => 404, 'headers' => [], 'body' => ['code' => 'content_unavailable']]);
            return;
        }
    }
}
$response = rest_do_request($request);
$body = $response->get_data();
// Exclude password-protected posts from lists too; preserve pagination headers.
if (is_array($body) && array_is_list($body)) {
    $body = array_values(array_filter($body, static function ($row) {
        return !isset($row['password']) || $row['password'] === '';
    }));
}
if (preg_match('#^/wp/v2/(posts|pages)(/|$)#', $route) && $response->get_status() === 200) {
    $normalize = static function ($row) {
        $row['title']['rendered'] = '';
        $row['content']['rendered'] = '';
        unset($row['password']);
        return $row;
    };
    $body = array_is_list($body) ? array_map($normalize, $body) : $normalize($body);
}
echo wp_json_encode(['status' => $response->get_status(), 'headers' => $response->get_headers(), 'body' => $body]);
