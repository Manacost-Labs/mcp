<?php
/** Run with WP-CLI eval-file against the selected site; capture stdout privately. */
if (!defined('WP_CLI') || !WP_CLI) {
    exit(1);
}
$login = 'manacost-mcp';
if (get_user_by('login', $login)) {
    WP_CLI::error('Existing integration account preserved; revoke/rotate its application password explicitly.');
}
// Native REST context=edit requires edit capabilities to retrieve raw published
// bodies. The MCP exposes only GET operations; this account has no admin powers.
$role = 'manacost_mcp_reader';
if (get_role($role)) {
    WP_CLI::error('Existing integration role preserved.');
}
add_role($role, 'Manacost MCP content reader', array_fill_keys([
    'read', 'edit_posts', 'edit_others_posts', 'edit_published_posts',
    'edit_pages', 'edit_others_pages', 'edit_published_pages',
], true));
$id = wp_insert_user([
    'user_login' => $login,
    'user_pass' => wp_generate_password(64, true, true),
    'user_email' => 'manacost-mcp@hearthpulse.net',
    'display_name' => 'Manacost MCP',
    'role' => $role,
]);
if (is_wp_error($id)) {
    remove_role($role);
    WP_CLI::error('Integration user creation failed.');
}
$result = ['username' => $login, 'userId' => $id];
// Native reader needs only the account/role; its HTTP secret is separate.
if (($args[0] ?? '') === 'application-password') {
    if (!wp_is_application_passwords_available_for_user(get_userdata($id))) {
        WP_CLI::error('Application Passwords are disabled for this role; use the private reader. Account preserved.');
    }
    $password = WP_Application_Passwords::create_new_application_password($id, ['name' => 'Manacost MCP read-only tools']);
    if (is_wp_error($password)) {
        WP_CLI::error('Application password creation failed. Account preserved.');
    }
    $result['password'] = $password[0];
    $result['uuid'] = $password[1]['uuid'];
}
echo wp_json_encode($result);
