# Contributing to @ocoda/event-sourcing

Thank you for considering contributing to this project! We appreciate your help in improving it. To make the process smooth, please follow these guidelines.

## How to Contribute

### Prerequisites
```shell
node: "^>=20.0.0"
pnpm: "^10.4.0"
# otherwise, your build will fail
```

### Supported database versions
The repository uses Docker Compose to spin up local database services for integration tests. To keep CI and local runs stable we pin the images used in `docker-compose.yml`. Supported versions:

```text
Postgres: postgres:14
MongoDB: mongo:8
MariaDB: mariadb:10.11
DynamoDB Local: amazon/dynamodb-local:1.15.0
```

To start one or more of the pinned services locally:

```bash
docker compose up -d postgres mariadb
```


### Steps

1. **Fork the Repository**  
  Create a personal fork of the repository by clicking the “Fork” button.

2. **Clone your Fork**  
  Clone your forked repository locally:
    ```bash
    git clone https://github.com/@ocoda/event-sourcing.git
    ```

3. **Create a branch**
    ```bash
    git checkout -b feature/your-feature-name
    ```

4. **Install the dependencies**
  @ocoda/event-sourcing uses pnpm workspaces, so the dependencies need to be installed from the project root directory.
    ```bash
    pnpm install
    ```

5. **Start the docker container(s)**
  When making changes to the core library situated under */packages/core* there are no dependencies on any of the docker containers. However, if changing one of the integration packages situated under */packages/integration*, so will need to spin up one of the databases in order to test your changes. For example:
    ```bash
    docker compose up -d mariadb
    ```

6. **Make Your Changes**
  Ensure your code follows the project’s coding standards and passes tests.

   **Testing expectations:** keep minimum coverage at 90% for core and integration packages, keep patch coverage at 90% for new or changed code, run targeted suites locally when possible (`pnpm test --filter=@ocoda/event-sourcing` and `pnpm test:cov --filter=@ocoda/event-sourcing`), and start the matching Docker service from `docker-compose.yml` for integration tests.

7. **Lint and format your changes**
  To make sure your changes are in accordance to the styles used in this repository and pass the CI checks, you can run the linting and formatting steps.
    ```bash
    pnpm lint format
    ```

   **Release notes (changesets + AI):** release automation relies on changesets for versioning. Release notes are enhanced with AI when the `ANTHROPIC_API_KEY` secret is configured in the repository. Contributors do not need to run the AI generation locally; the workflow will skip AI notes when the secret is missing.

   **Dependency updates:** dependency PRs are handled by Renovate with auto-merge for low-risk patch/minor updates. Major and 0.x updates require manual review. Dependabot remains enabled for alerts only, and Renovate PRs get auto-generated changesets.

8. **Commit Your Changes**
  Write clear and concise commit messages:
    ```bash
    git commit -m "Add description of your changes"
    ```

    > [!IMPORTANT]  
    > When making changes to the core library or one of the integrations, make sure to include a changeset.
    ```bash
    pnpm exec changeset
    ```

9. **Push to Your Fork**
  Push your changes to your forked repository:
    ```bash
    git push origin feature/your-feature-name
    ```

10. **Create a Pull Request**
    Go to the original repository, and click the “New Pull Request” button. Fill in details about the changes and submit.
  
