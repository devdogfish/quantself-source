\set ON_ERROR_STOP on
SELECT format('CREATE ROLE quantself_analytics_reader LOGIN PASSWORD %L', :'reader_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'quantself_analytics_reader') \gexec
SELECT format('ALTER ROLE quantself_analytics_reader PASSWORD %L', :'reader_password') \gexec
GRANT CONNECT ON DATABASE umami TO quantself_analytics_reader;
GRANT USAGE ON SCHEMA public TO quantself_analytics_reader;
GRANT SELECT ON website_event, event_data TO quantself_analytics_reader;
ALTER ROLE quantself_analytics_reader SET default_transaction_read_only = on;
