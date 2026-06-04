-- runs once on first postgres init
CREATE ROLE walletwise_ro LOGIN PASSWORD 'walletwise_ro';
GRANT CONNECT ON DATABASE walletwise TO walletwise_ro;
GRANT USAGE ON SCHEMA public TO walletwise_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO walletwise_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO walletwise_ro;
