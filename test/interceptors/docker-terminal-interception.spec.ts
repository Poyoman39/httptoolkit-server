import * as _ from 'lodash';
import * as path from 'path';
import * as Docker from 'dockerode';

import { expect } from 'chai';

import { setupTest } from './interceptor-test-utils';
import { spawnToResult } from '../../src/util/process-management';

import { getTerminalEnvVars } from '../../src/interceptors/terminal/terminal-env-overrides';

import {
    startDockerInterceptionServices,
    stopDockerInterceptionServices
} from '../../src/interceptors/docker/docker-interception-services';

const testSetup = setupTest();

describe('Docker CLI interception', function () {
    this.timeout(20000);

    beforeEach(async () => {
        const { server, httpsConfig } = await testSetup;
        await server.start();
        await startDockerInterceptionServices(server.port, httpsConfig);
    });

    afterEach(async () => {
        const { server } = await testSetup;
        await stopDockerInterceptionServices(server.port);
        await server.stop();
    });

    it("should intercept 'docker run'", async () => {
        const { server, httpsConfig } = await testSetup;

        const mainRule = await server.get("https://example.test").thenReply(200);

        const terminalEnvOverrides = getTerminalEnvVars(server.port, httpsConfig, process.env);

        const { exitCode, stdout, stderr } = await spawnToResult(
            'docker', ['run', '--rm', 'node:14', '-e', `require("https").get("https://example.test")`],
            { env: { ...process.env, ...terminalEnvOverrides } },
            true
        );

        expect(exitCode).to.equal(0);
        expect(stdout).to.equal('');
        expect(stderr).to.equal('');

        const seenRequests = await mainRule.getSeenRequests();
        expect(seenRequests.length).to.equal(1);
        expect(seenRequests[0].url).to.equal("https://example.test/");
    });

    it("should intercept 'docker build'", async function () {
        this.timeout(30000);

        const { server, httpsConfig } = await testSetup;

        const mainRule = await server.anyRequest().thenReply(200, "Mock response\n");

        const terminalEnvOverrides = getTerminalEnvVars(server.port, httpsConfig, process.env);

        const { exitCode, stdout, stderr } = await spawnToResult('docker', ['build', '.'], {
            env: { ...process.env, ...terminalEnvOverrides },
            cwd: path.join(__dirname, '..', 'fixtures', 'docker', 'requests-in-build')
        }, true);

        expect(exitCode).to.equal(0);

        const seenRequests = await mainRule.getSeenRequests();
        expect(seenRequests.length).to.equal(3);
        expect(seenRequests.map(r => r.url)).to.deep.equal([
            "https://base-request.test/",
            "https://base2-request.test/",
            "https://final-stage-request.test/"
        ]);

        expect(
            stdout.replace(
                // Replace hashes with <hash> in every place docker might use them:
                /(?<=(--->|---> Running in|Removing intermediate container|Successfully built) )[a-z0-9]{12}/g,
                '<hash>'
            )
        ).to.equal(
`Sending build context to Docker daemon  3.072kB\r\r
Step 1/8 : FROM node:14 as base-image
 ---> <hash>
 *** Enabling HTTP Toolkit interception ***
 ---> <hash>
Step 2/8 : RUN curl -s https://base-request.test
 ---> Running in <hash>
Mock response
Removing intermediate container <hash>
 ---> <hash>
Step 3/8 : FROM node:14 as base-image-2
 ---> <hash>
 *** Enabling HTTP Toolkit interception ***
 ---> <hash>
Step 4/8 : COPY . .
 ---> <hash>
Step 5/8 : RUN curl -s https://base2-request.test
 ---> Running in <hash>
Mock response
Removing intermediate container <hash>
 ---> <hash>
Step 6/8 : FROM base-image
 ---> <hash>
 *** Enabling HTTP Toolkit interception ***
 ---> <hash>
Step 7/8 : COPY --from=base-image-2 make-request.js .
 ---> <hash>
Step 8/8 : RUN node ./make-request.js https://final-stage-request.test
 ---> Running in <hash>
Making request to https://final-stage-request.test
Got 200 response
Removing intermediate container <hash>
 ---> <hash>
Successfully built <hash>
`
        );
        expect(stderr).to.equal('');
    });

    it("should intercept 'docker-compose up'", async function () {
        this.timeout(30000);

        const { server, httpsConfig, getPassThroughOptions } = await testSetup;
        const externalRule = await server.get("https://example.test").thenReply(200, "Mock response");
        const internalRule = await server.post().thenPassThrough(await getPassThroughOptions());

        // Create non-intercepted docker-compose containers, like normal use:
        const composeRoot = path.join(__dirname, '..', 'fixtures', 'docker', 'compose');
        await spawnToResult('docker-compose', ['create', '--force-recreate'], { cwd: composeRoot });

        const terminalEnvOverrides = getTerminalEnvVars(server.port, httpsConfig, process.env);

        // "DC Up" the same project, but in an intercepted env. Should ignore the existing containers,
        // create new intercepted containers, and then up those as normal.
        const { exitCode, stdout } = await spawnToResult(
            'docker-compose', ['up'],
            {
                env: { ...process.env, ...terminalEnvOverrides },
                cwd: composeRoot
            },
            true
        );

        expect(exitCode).to.equal(0);
        expect(stdout).to.include("All requests ok");

        const seenExternalRequests = await externalRule.getSeenRequests();
        expect(seenExternalRequests.length).to.be.gte(2);

        const seenInternalRequests = await internalRule.getSeenRequests();
        const seenInternalUrls = seenInternalRequests.map(r => r.url);
        expect(seenInternalUrls).to.include("http://service-a:8000/");
        expect(seenInternalUrls).to.include("http://service-b:8000/");
    });

});
