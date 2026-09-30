import Foundation
import Testing
@testable import TilecastCore

@Suite struct InstallationIdentityTests {
    func body(_ fields: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["data": fields])
    }

    let valid: [String: Any] = [
        "product": "tilecast",
        "apiVersion": "v1",
        "installationId": "de300000-0000-4000-8000-000000000000",
        "organizationName": "  Tilecast Demo District ",
        "pairingEnabled": true,
    ]

    @Test func decodesTheIdentityDocument() throws {
        let identity = try InstallationIdentity.decode(body(valid))
        #expect(identity.installationID == UUID(uuidString: "de300000-0000-4000-8000-000000000000"))
        #expect(identity.organizationName == "Tilecast Demo District")
    }

    @Test func ignoresFieldsAddedByNewerServers() throws {
        var fields = valid
        fields["futureField"] = ["nested": 1]
        #expect(throws: Never.self) { try InstallationIdentity.decode(body(fields)) }
    }

    @Test func refusesOtherProductsAndMalformedDocuments() throws {
        var other = valid
        other["product"] = "something-else"
        #expect(throws: InstallationIdentityError.notTilecast) { try InstallationIdentity.decode(body(other)) }

        var badID = valid
        badID["installationId"] = "not-a-uuid"
        #expect(throws: InstallationIdentityError.notTilecast) { try InstallationIdentity.decode(body(badID)) }

        #expect(throws: InstallationIdentityError.notTilecast) {
            try InstallationIdentity.decode(Data("<html>Router login</html>".utf8))
        }
        let oversized = Data(repeating: 0x20, count: InstallationIdentity.maximumDocumentBytes + 1)
        #expect(throws: InstallationIdentityError.notTilecast) { try InstallationIdentity.decode(oversized) }
    }

    @Test func reportsUnknownAPIMajorVersions() throws {
        var future = valid
        future["apiVersion"] = "v2"
        #expect(throws: InstallationIdentityError.unsupportedAPIVersion("v2")) {
            try InstallationIdentity.decode(body(future))
        }
    }

    @Test func classifiesTransportErrors() {
        #expect(InstallationIdentityClient.classify(URLError(.serverCertificateUntrusted)) == .untrustedCertificate)
        #expect(InstallationIdentityClient.classify(URLError(.serverCertificateHasBadDate)) == .untrustedCertificate)
        #expect(InstallationIdentityClient.classify(URLError(.cannotConnectToHost)) == .unreachable)
        #expect(InstallationIdentityClient.classify(URLError(.timedOut)) == .unreachable)
    }
}
